declare module '*.svelte' {
  const component: import('svelte').Component<{ page: import('#src/dtos/launcher.dto').LauncherPage }>;
  export default component;
}
