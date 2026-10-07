import type { NextConfig } from 'next';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4000';

const config: NextConfig = {
  reactStrictMode: true,
  // Phone testing: allow the LAN HTTPS host or tunnel host to load dev assets (comma-separated hosts).
  allowedDevOrigins: (process.env.DEV_ALLOWED_ORIGINS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
  poweredByHeader: false,
  // The browser talks to /api/v1 on the same origin; session cookies stay first-party.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_ORIGIN}/api/v1/:path*` }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: [
          "default-src 'self'", "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''),
          "style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self' data: blob: https://*.storageapi.dev https://localhost:9000 http://localhost:9000",
          "connect-src 'self' https://*.storageapi.dev https://localhost:9000 http://localhost:9000" + (process.env.NODE_ENV === 'development' ? ' ws: wss:' : ''),
          "media-src 'self' blob:", "frame-src 'self' blob: https://*.storageapi.dev https://localhost:9000 http://localhost:9000",
          "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
        ].join('; ') },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        { key: 'X-Frame-Options' , value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
      ],
    }];
  },
};

export default config;
