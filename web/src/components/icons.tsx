// Ícones inline (stroke = currentColor), sem dependências externas.

import type { ReactNode, SVGProps } from 'react'

type IconProps = { className?: string }

function base(className: string | undefined, children: ReactNode, extra?: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...extra}
    >
      {children}
    </svg>
  )
}

export function ClockIcon({ className }: IconProps) {
  return base(className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ))
}

export function LogoutIcon({ className }: IconProps) {
  return base(className, (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ))
}

export function UserIcon({ className }: IconProps) {
  return base(className, (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </>
  ))
}

export function ZapIcon({ className }: IconProps) {
  return base(className, <path d="M13 2L4.8 12.7c-.3.4 0 .9.5.9H11l-1.4 7.6c-.1.7.8 1.1 1.2.4L19 10.9c.3-.4 0-.9-.5-.9H13l.9-7.3c.1-.6-.6-1-1-.7z" />)
}

export function MapIcon({ className }: IconProps) {
  return base(className, (
    <>
      <path d="M9 3L3.7 5.2A1 1 0 0 0 3 6.1V19a1 1 0 0 0 1.3.9L9 18l6 3 5.3-2.2a1 1 0 0 0 .7-.9V5a1 1 0 0 0-1.3-.9L15 6z" />
      <path d="M9 3v15" />
      <path d="M15 6v15" />
    </>
  ))
}

export function UsersIcon({ className }: IconProps) {
  return base(className, (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9.5" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ))
}

export function CalendarIcon({ className }: IconProps) {
  return base(className, (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 11h18" />
    </>
  ))
}

export function FileIcon({ className }: IconProps) {
  return base(className, (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h8M8 9h2" />
    </>
  ))
}

export function RefreshIcon({ className }: IconProps) {
  return base(className, (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </>
  ))
}

export function PlusIcon({ className }: IconProps) {
  return base(className, (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ))
}

export function XIcon({ className }: IconProps) {
  return base(className, (
    <>
      <path d="M18 6L6 18M6 6l12 12" />
    </>
  ))
}

export function CheckIcon({ className }: IconProps) {
  return base(className, <path d="M20 6L9 17l-5-5" />)
}

export function PrintIcon({ className }: IconProps) {
  return base(className, (
    <>
      <path d="M6 9V3h12v6" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" rx="1" />
    </>
  ))
}

export function DownloadIcon({ className }: IconProps) {
  return base(className, (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ))
}

export function EyeIcon({ className }: IconProps) {
  return base(className, (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ))
}