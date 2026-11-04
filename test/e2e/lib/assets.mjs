/**
 * What the browser loaded for an element, to compare it with the file that the extension ships. Both run in the page
 * and fetch the URL again, which the browser answers from the same server.
 */

/** The SHA-256 of the bytes behind the `src` of an `<img>` (a locator), as lower-case hex. */
export function imageSha256(image) {
  return image.evaluate(async (element) => {
    const bytes = await (await fetch(element.src)).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  });
}

/**
 * The image that an element is drawn with as a CSS mask, which is how VS Code draws the icon of a view container
 * in the Activity Bar (so that it takes the color of the theme). Resolves to { url, status, contentType, text };
 * `url` is undefined when the element has no mask image.
 */
export function maskImageOf(element) {
  return element.evaluate(async (node) => {
    const url = /^url\("?(.*?)"?\)$/.exec(getComputedStyle(node).maskImage)?.[1];
    if (url === undefined) {
      return { url };
    }
    const response = await fetch(url);
    return {
      url,
      status: response.status,
      contentType: response.headers.get('content-type'),
      text: await response.text(),
    };
  });
}
