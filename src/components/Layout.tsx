import { Outlet } from 'react-router'
import { TabBar } from './TabBar'
import { NetworkBadge } from './NetworkBadge'

export function Layout() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[430px] flex-col">
      <NetworkBadge />
      <Outlet />
      <TabBar />
    </div>
  )
}
