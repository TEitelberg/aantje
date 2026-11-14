/// <reference lib="dom" />
// How the drawn plan answers the mouse: dragging moves it, the tooltip follows the mouse inside the visible part, and a
// click pins a tooltip.
import type { ECharts } from 'echarts/core';

/** Dragging with the mouse moves the plan like the scroll bars; the result says whether a drag ended just now. */
export function enablePanning(scroller: HTMLElement): () => boolean {
  let drag: { x: number; y: number; left: number; top: number } | undefined;
  let draggedAt = 0;
  scroller.addEventListener('pointerdown', (event) => {
    if (event.button === 0) {
      drag = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    }
  });
  scroller.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const [dx, dy] = [event.clientX - drag.x, event.clientY - drag.y];
    if (!scroller.classList.contains('dragging') && Math.abs(dx) + Math.abs(dy) < 4) return;
    scroller.classList.add('dragging');
    scroller.setPointerCapture(event.pointerId);
    scroller.scrollLeft = drag.left - dx;
    scroller.scrollTop = drag.top - dy;
  });
  const endDrag = (): void => {
    if (scroller.classList.contains('dragging')) draggedAt = Date.now();
    drag = undefined;
    scroller.classList.remove('dragging');
  };
  scroller.addEventListener('pointerup', endDrag);
  scroller.addEventListener('pointercancel', endDrag);
  return () => Date.now() - draggedAt < 300;
}

export type TooltipPosition = (
  point: [number, number],
  params: { dataIndex?: number },
  dom: HTMLElement,
  rect: unknown,
  size: { contentSize: [number, number] },
) => [number, number];

/** Next to the mouse, inside the visible part of the drawing, which scrolls; at most 360 px high, it scrolls itself. */
export function followMouse(scroller: HTMLElement): TooltipPosition {
  return (point, _params, dom, _rect, size) => {
    const [left, top] = [scroller.scrollLeft, scroller.scrollTop];
    const [visibleWidth, visibleHeight] = [scroller.clientWidth, scroller.clientHeight];
    const maxHeight = Math.max(100, Math.min(360, visibleHeight - 16));
    dom.style.maxHeight = `${maxHeight}px`;
    const [width, height] = [size.contentSize[0], Math.min(size.contentSize[1], maxHeight)];
    let x = point[0] + 14;
    if (x + width > left + visibleWidth - 4) x = point[0] - width - 14;
    let y = point[1] + 14;
    if (y + height > top + visibleHeight - 4) y = top + visibleHeight - height - 4;
    return [Math.max(left + 4, x), Math.max(top + 4, y)];
  };
}

export interface Pinning {
  /** The tile whose tooltip is pinned. */
  index(): number | undefined;
  /** Where a tooltip goes: a pinned one where it was pinned, any other one after the mouse. */
  position(follow: TooltipPosition): TooltipPosition;
  /** A new drawing releases the pin. */
  reset(): void;
}

/**
 * A click on a tile pins its tooltip where it is, so that the mouse can go into it and scroll; a click on that tile
 * again or on a free spot, or the mouse over another tile, releases it. The mouse-up of a drag pins nothing.
 */
export function pinning(chart: ECharts, justDragged: () => boolean): Pinning {
  let pinned: number | undefined;
  let pinnedAt: [number, number] | undefined;
  const release = (): void => {
    pinned = undefined;
    pinnedAt = undefined;
    chart.setOption({ tooltip: { alwaysShowContent: false } });
  };
  chart.on('click', (params) => {
    const { dataIndex, event } = params as {
      dataIndex?: number;
      event?: { offsetX: number; offsetY: number };
    };
    if (typeof dataIndex !== 'number' || justDragged()) return;
    if (pinned === dataIndex) {
      release();
      chart.dispatchAction({ type: 'hideTip' });
      return;
    }
    pinned = dataIndex;
    pinnedAt = undefined;
    chart.setOption({ tooltip: { alwaysShowContent: true } });
    if (event) chart.dispatchAction({ type: 'showTip', x: event.offsetX, y: event.offsetY });
  });
  chart.on('mouseover', (params) => {
    if (pinned !== undefined && params.dataIndex !== pinned) release();
  });
  chart.getZr().on('click', (event) => {
    if (!event.target && pinned !== undefined && !justDragged()) {
      release();
      chart.dispatchAction({ type: 'hideTip' });
    }
  });
  return {
    index: () => pinned,
    position: (follow) => (point, params, dom, rect, size) => {
      if (pinned === undefined || params.dataIndex !== pinned) return follow(point, params, dom, rect, size);
      pinnedAt ??= follow(point, params, dom, rect, size);
      return pinnedAt;
    },
    reset: () => {
      pinned = undefined;
      pinnedAt = undefined;
    },
  };
}
