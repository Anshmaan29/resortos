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
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
      ],
    }];
  },
};

export default config;
