// 线条图标（24x24 坐标系，跟随文字颜色）

const PATHS = {
  inbox: 'M3 13l3-8h12l3 8v6H3z M3 13h5l1 2h6l1-2h5',
  sent: 'M4 12l16-8-6 16-3-7z M11 13l9-9',
  drafts: 'M14 3H6v18h12V7z M14 3v4h4 M9 13h6 M9 17h4',
  archive: 'M3 5h18v4H3z M5 9v10h14V9 M10 13h4',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
  junk: 'M12 3l9 9-9 9-9-9z M12 8v5 M12 16v.5',
  all: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  folder: 'M3 6h6l2 2h10v11H3z',
  reply: 'M10 6L4 12l6 6 M4 12h10a6 6 0 0 1 6 6',
  replyAll: 'M8 6L2 12l6 6 M13 6l-6 6 6 6 M7 12h8a6 6 0 0 1 6 6',
  forward: 'M14 6l6 6-6 6 M20 12H10a6 6 0 0 0-6 6',
  clip: 'M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M16 16l5 5',
  sliders: 'M4 7h9 M17 7h3 M15 5v4 M4 12h3 M11 12h9 M9 10v4 M4 17h11 M19 17h1 M17 15v4',
  plus: 'M12 5v14 M5 12h14',
  pen: 'M4 20h4L19 9l-4-4L4 16z M14 6l4 4',
  x: 'M6 6l12 12 M18 6L6 18',
  unread: 'M3 6h18v12H3z M3 7l9 6 9-6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  download: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4',
  chevron: 'M9 6l6 6-6 6',
  bullets: 'M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  userPlus: 'M15 19a6 6 0 0 0-12 0 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M19 8v6 M16 11h6',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  check: 'M5 12l5 5 9-10',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  back: 'M15 6l-6 6 6 6',
  calendarClock: 'M4 6h16v6 M4 6v13h8 M8 3v4 M16 3v4 M17 14a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M17 16.5V18l1 1',
  palette: 'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-.6-1.6-.6-2.4c0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z M7.5 12h.01 M9.5 8h.01 M14.5 8h.01',
  pin: 'M9 4h6l-1 6 3 3H7l3-3z M12 13v7',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7.5V12l3 2',
  ban: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M5.7 5.7l12.6 12.6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 20a8 8 0 0 1 16 0',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  mailOpen: 'M3 10l9-6 9 6v10H3z M3 10l9 6 9-6',
  checkAll: 'M2 13l4 4 8-9 M11 17l1 0 9-10',
  move: 'M3 6h6l2 2h10v11H3z M8 13.5h7 M12.5 11l2.5 2.5-2.5 2.5',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4z M10 20a2 2 0 0 0 4 0',
  bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
  circle: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  chevronDown: 'M6 9l6 6 6-6',
  arrowUp: 'M12 19V5 M6 11l6-6 6 6',
  arrowDown: 'M12 5v14 M6 13l6 6 6-6',
  printer: 'M7 8V4h10v4 M7 17H4V9h16v8h-3 M7 14h10v6H7z',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  share: 'M12 15V4 M8 8l4-4 4 4 M5 12v8h14v-8',
  spam: 'M4 5h16v14H4z M9.5 9.5l5 5 M14.5 9.5l-5 5',
  checkCircle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M8 12.4l2.7 2.7L16 9.6',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v6 M12 7.5v.5'
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
