// Vite's `?raw` import: the file's text (dials.test.ts reads wrangler.jsonc this way).
declare module "*?raw" {
  const text: string;
  export default text;
}
