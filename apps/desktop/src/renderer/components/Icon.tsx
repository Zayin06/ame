import type { ReactNode } from 'react'

const paths: Record<string, ReactNode> = {
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  overview: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16M14 10h7" /></>,
  brand: <path d="M12 3l8 18-8-4.5L4 21l8-18z" />,
  shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z" /><path d="m9 12 2 2 4-4" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  git: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 7v10m0-5c8 0 12 0 12-4" /></>,
  down: <path d="m6 9 6 6 6-6" />,
  bottom: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 14h18" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  moon: <path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z" />,
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="1" />,
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
  settings: <><path d="m9 3-.6 3-2 .9-2.6-1-2 3.4L4 11v2l-2.2 1.7 2 3.4 2.6-1 2 .9.6 3h4l.6-3 2-.9 2.6 1 2-3.4L18 13v-2l2.2-1.7-2-3.4-2.6 1-2-.9L13 3Z" /><circle cx="11" cy="12" r="3" /></>,
  account: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
  more: <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>,
  folder: <path d="M3 7V5h6l2 2h10v13H3Z" />,
  file: <><path d="M5 3h9l5 5v13H5Z M14 3v6h5" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  left: <path d="m15 18-6-6 6-6" />,
  agents: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v1" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m6 9 3 3-3 3m6 0h5" /></>,
  diff: <><path d="M5 3h9l5 5v13H5ZM8 12h8m-4-4v8M8 18h8" /></>
}
export function Icon({ name }: { name: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.file}</svg>
}
