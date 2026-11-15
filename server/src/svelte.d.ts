declare module '*.svelte' {
  const component: import('svelte').Component<import('#src/dtos/launcher.dto').PrototypePage>;
  export default component;
}
