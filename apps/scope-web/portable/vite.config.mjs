import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('../',import.meta.url)),build:{outDir:'dist-portable',emptyOutDir:true,manifest:true,rollupOptions:{input:fileURLToPath(new URL('./index.html',import.meta.url))}}});
