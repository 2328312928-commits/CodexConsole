// Files the build bundles as text.
declare module '*.html' {
  const text: string;
  export default text;
}
declare module '*.sh' {
  const text: string;
  export default text;
}

// Filled in by scripts/build.mjs.
declare const __DEPLOYER_VERSION__: string;
declare const __CONSOLE_VERSION__: string;
declare const __CONSOLE_COMMIT__: string;
