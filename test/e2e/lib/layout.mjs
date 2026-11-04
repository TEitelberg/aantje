/** The widths of the web view (CSS pixels) that the layout spec measures every panel at. */
export const WIDTHS = [560, 900, 1500];

/** The spacing (CSS pixels) that every page keeps to the edges of the web view: the value of `--aantje-gutter`. */
export const GUTTER = 20;

/** The distance (CSS pixels) between a row of cards and the block below it: the value of `--aantje-section-gap`. */
export const SECTION_GAP = 16;

const innerWidth = (frame) => frame.locator('body').evaluate(() => window.innerWidth);

/**
 * Resizes the browser window until the web view of the visible panel is `target` pixels wide (within a few pixels). A
 * panel that sits beside an editor changes by less than the window does, so the step is scaled by what the last one
 * achieved. Returns the width that was reached.
 */
export async function setWebviewWidth(page, frame, target) {
  let width = await innerWidth(frame);
  let slope = 1;
  for (let attempt = 0; attempt < 8 && Math.abs(width - target) > 6; attempt++) {
    const before = page.viewportSize();
    const next = Math.max(300, Math.round(before.width + (target - width) / slope));
    await page.setViewportSize({ width: next, height: before.height });
    await page.waitForTimeout(500);
    const reached = await innerWidth(frame);
    if (next !== before.width && reached !== width) {
      slope = Math.min(1, Math.max(0.2, (reached - width) / (next - before.width)));
    }
    width = reached;
  }
  return width;
}

/**
 * Measures the page of the panel in the web view: the boxes of all visible elements (cut at the edge of a scrolling
 * ancestor, because what scrolls inside its own container does not touch the page), the gaps to the edges of the view,
 * the elements that come closer than the gutter or leave the container, and the charts.
 */
export function measureLayout(frame) {
  return frame.locator('body').evaluate((body) => {
    const root = document.documentElement;
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:absolute;visibility:hidden;padding-left:var(--aantje-gutter,16px);padding-top:var(--aantje-section-gap,0px)';
    body.append(probe);
    const gutter = parseFloat(getComputedStyle(probe).paddingLeft);
    const sectionGap = parseFloat(getComputedStyle(probe).paddingTop);
    probe.remove();

    const tokenSet = getComputedStyle(root).getPropertyValue('--aantje-gutter').trim() !== '';
    const width = root.clientWidth;
    const app = document.querySelector('.app');
    const appBox = app?.getBoundingClientRect();
    const style = app ? getComputedStyle(app) : undefined;
    const content = {
      left: (appBox?.left ?? 0) + parseFloat(style?.paddingLeft ?? '0'),
      right: (appBox?.right ?? width) - parseFloat(style?.paddingRight ?? '0'),
    };
    const name = (element) =>
      `${element.tagName.toLowerCase()}${[...element.classList].map((c) => `.${c}`).join('')}`;
    const clip = (element, box) => {
      let left = box.left;
      let right = box.right;
      for (let up = element.parentElement; up && up !== body; up = up.parentElement) {
        if (getComputedStyle(up).overflowX !== 'visible') {
          const outer = up.getBoundingClientRect();
          left = Math.max(left, outer.left);
          right = Math.min(right, outer.right);
        }
      }
      return { left, right, top: box.top + window.scrollY, empty: right <= left };
    };
    const clear = (color) => color === 'transparent' || /,\s*0\)$/.test(color);
    // What the user sees: boxes with a border or a background, controls and charts, and the text itself.
    const paints = (element, css) =>
      ['CANVAS', 'IMG', 'INPUT', 'SELECT', 'TEXTAREA', 'svg'].includes(element.tagName) ||
      !clear(css.backgroundColor) ||
      css.backgroundImage !== 'none' ||
      ['Top', 'Right', 'Bottom', 'Left'].some(
        (side) =>
          parseFloat(css[`border${side}Width`]) > 0 &&
          css[`border${side}Style`] !== 'none' &&
          !clear(css[`border${side}Color`]),
      );

    const boxes = [];
    for (const element of body.querySelectorAll('*')) {
      if (element === app || ['SCRIPT', 'STYLE', 'OPTION'].includes(element.tagName)) {
        continue;
      }
      const css = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if ((box.width === 0 && box.height === 0) || css.visibility === 'hidden') {
        continue;
      }
      const seen = [];
      if (paints(element, css)) {
        seen.push(clip(element, box));
      }
      for (const child of element.childNodes) {
        if (child.nodeType === 3 /* a text node */ && child.textContent.trim() !== '') {
          const range = document.createRange();
          range.selectNodeContents(child);
          const text = range.getBoundingClientRect();
          if (text.width > 0) {
            seen.push(clip(element, text));
          }
        }
      }
      for (const one of seen) {
        if (!one.empty) {
          boxes.push({ element, ...one });
        }
      }
    }
    const scrollers = [...body.querySelectorAll('*')]
      .filter((e) => getComputedStyle(e).overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1)
      .map((e) => `${name(e)} ${e.scrollWidth}>${e.clientWidth}`);
    const near = (box) => box.left < gutter - 1 || width - box.right < gutter - 1;
    const outside = boxes.filter((box) => box.left < content.left - 1 || box.right > content.right + 1);
    const canvases = [...body.querySelectorAll('canvas')].map((canvas) => {
      const box = canvas.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        inside: box.left >= content.left - 1 && box.right <= content.right + 1,
      };
    });
    // The distance from each row of cards to the next visible block below it (a wrapper of the row is left first).
    const tileGaps = [...body.querySelectorAll('.cards')].flatMap((cards) => {
      const bottom = cards.getBoundingClientRect().bottom;
      if (cards.getBoundingClientRect().height === 0) return [];
      for (let anchor = cards; anchor && anchor !== app; anchor = anchor.parentElement) {
        for (let next = anchor.nextElementSibling; next; next = next.nextElementSibling) {
          const box = next.getBoundingClientRect();
          if (box.height > 0) return [{ after: name(next), gap: box.top - bottom }];
        }
      }
      return [];
    });
    // The distance from each h2 to the bottom of the block before it. A heading that starts a wrapper has no sibling in it,
    // so the search goes up wrapper by wrapper to the first earlier sibling that takes room (the margin of the heading
    // collapses through plain wrappers; it is measured, not assumed). A heading at the top of a box with its own border or
    // padding is flush to the edge of that box on purpose and is not measured, and neither is one without any block before it.
    const takesRoom = (element) => {
      const css = getComputedStyle(element);
      return (
        element.getBoundingClientRect().height > 0 &&
        css.visibility !== 'hidden' &&
        !['absolute', 'fixed'].includes(css.position)
      );
    };
    const headingGaps = [...body.querySelectorAll('h2')].flatMap((heading) => {
      const top = heading.getBoundingClientRect().top;
      if (!takesRoom(heading)) return [];
      for (let anchor = heading; anchor && anchor !== app; anchor = anchor.parentElement) {
        if (anchor !== heading) {
          const css = getComputedStyle(anchor);
          if (parseFloat(css.paddingTop) > 0 || parseFloat(css.borderTopWidth) > 0) return [];
        }
        for (let before = anchor.previousElementSibling; before; before = before.previousElementSibling) {
          if (takesRoom(before)) {
            return [
              {
                heading: heading.textContent.trim().slice(0, 40),
                after: name(before),
                gap: top - before.getBoundingClientRect().bottom,
              },
            ];
          }
        }
      }
      return [];
    });
    const describe = (box) => `${name(box.element)} [${Math.round(box.left)}..${Math.round(box.right)}]`;
    return {
      innerWidth: window.innerWidth,
      clientWidth: width,
      scrollWidth: root.scrollWidth,
      gutter,
      sectionGap,
      tileGaps,
      headingGaps,
      tokenSet,
      leftGap: Math.min(...boxes.map((box) => box.left)),
      rightGap: width - Math.max(...boxes.map((box) => box.right)),
      topGap: Math.min(...boxes.map((box) => box.top)),
      elements: boxes.length,
      near: [...new Set(boxes.filter(near).map(describe))].slice(0, 12),
      outside: [...new Set(outside.map(describe))].slice(0, 12),
      scrollers: [...new Set(scrollers)].slice(0, 8),
      canvases,
    };
  });
}

/**
 * The problems of one measurement as texts (none when the page keeps the gutter on both sides (on the right a page may
 * end earlier, a few cards or a short line do not fill the width), has no horizontal scroll
 * bar, its charts are inside the container, a row of cards has one section gap to the block below it, and every heading
 * has at least one section gap to the block above it). `tolerance` is in CSS pixels.
 */
export function layoutProblems(m, { gutter = GUTTER, sectionGap = SECTION_GAP, tolerance = 2 } = {}) {
  const problems = [];
  const close = (value) => Math.abs(value - gutter) <= tolerance;
  if (!m.tokenSet || m.gutter !== gutter) problems.push(`the token --aantje-gutter is not ${gutter}px`);
  if (m.scrollWidth > m.clientWidth + 1) {
    problems.push(`the page scrolls horizontally (${m.scrollWidth} > ${m.clientWidth})`);
  }
  if (!close(m.leftGap)) problems.push(`gap to the left edge is ${m.leftGap.toFixed(1)}px`);
  if (m.rightGap < gutter - tolerance) problems.push(`gap to the right edge is ${m.rightGap.toFixed(1)}px`);
  if (!close(m.topGap)) problems.push(`gap to the top edge is ${m.topGap.toFixed(1)}px`);
  if (m.near.length > 0) problems.push(`closer than the gutter: ${m.near.join(', ')}`);
  if (m.outside.length > 0) problems.push(`outside the container: ${m.outside.join(', ')}`);
  if (m.canvases.some((canvas) => !canvas.inside)) problems.push('a chart leaves the container');
  if (m.sectionGap !== sectionGap) problems.push(`the token --aantje-section-gap is not ${sectionGap}px`);
  for (const { after, gap } of m.tileGaps) {
    if (gap < sectionGap - tolerance)
      problems.push(`${after} is ${gap.toFixed(1)}px below the cards, not ${sectionGap}px`);
  }
  for (const { heading, after, gap } of m.headingGaps) {
    if (gap < sectionGap - tolerance)
      problems.push(`the heading "${heading}" is ${gap.toFixed(1)}px below ${after}, not ${sectionGap}px`);
  }
  return problems;
}
