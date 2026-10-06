import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

const inter = localFont({ src: '../fonts/inter-latin.woff2', weight: '100 900', style: 'normal', variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'ResortOS', template: '%s · ResortOS' },
  description: 'Resort management for Indian resorts',
  applicationName: 'ResortOS',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f7f6f3' }, { media: '(prefers-color-scheme: dark)', color: '#12130f' }],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN" className={inter.variable}>
      <body className="min-h-dvh font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
