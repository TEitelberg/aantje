/**
 * An argument for `t.shot` that crops the screenshot to the box of `target` (a locator) plus `margin` CSS pixels on
 * every side. With `through` (another locator) the crop reaches down to the bottom of that element instead, for
 * example from the top of the Activity Bar to the bottom of one of its tabs.
 */
export async function around(page, target, { margin = 8, through = target } = {}) {
  const first = await target.boundingBox();
  const last = await through.boundingBox();
  if (!first || !last) {
    throw new Error('Cannot crop around an element that has no box on the page.');
  }
  const viewport = page.viewportSize();
  const left = Math.max(0, first.x - margin);
  const top = Math.max(0, first.y - margin);
  const right = Math.min(viewport.width, first.x + first.width + margin);
  const bottom = Math.min(viewport.height, last.y + last.height + margin);
  return { clip: { x: left, y: top, width: right - left, height: bottom - top } };
}
