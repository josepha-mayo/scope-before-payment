import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({build:{outDir:'dist-test',emptyOutDir:true,rollupOptions:{input:fileURLToPath(new URL('./index.html',import.meta.url))}}});
