import type { MetadataRoute } from 'next';
export default function manifest(): MetadataRoute.Manifest {
  return { name: 'ResortOS', short_name: 'ResortOS', description: 'Hotel reception', start_url: '/', scope: '/', display: 'standalone', background_color: '#12130f', theme_color: '#12130f', icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ] };
}
