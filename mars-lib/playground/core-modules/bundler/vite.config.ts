export default {
  root: "/workspace/app",
  define: {
    __MARS_LABEL__: '"Core Module Bundler"',
  },
  resolve: {
    alias: {
      "@": "/workspace/app/src",
    },
  },
  server: {
    hmr: true,
  },
}
