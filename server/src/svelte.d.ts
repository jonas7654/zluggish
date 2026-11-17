declare module '*.svelte' {
  const component: import('svelte').Component<{ page: import('#src/dtos/game-app.dto').GamePageModel }>;
  export default component;
}
