import './globals.css';
import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Ragyu Pazar ve Fiyat Analiz Merkezi', description: 'Rakip fiyat ve pazar analizi', robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="tr"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body>{children}</body></html>);
}
