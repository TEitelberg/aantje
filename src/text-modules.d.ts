// Text files that the bundles take in as strings: esbuild's `text` loader, and a plugin in vitest.config.mts.
declare module '*.yaml' {
  const text: string;
  export default text;
}
