import { Outlet } from 'react-router'
import { TabBar } from './TabBar'
import { NetworkBadge } from './NetworkBadge'
import { UpdateBanner } from './UpdateBanner'

export function Layout() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[430px] flex-col">
      <UpdateBanner />
      <Outlet />
      <NetworkBadge />
      <TabBar />
    </div>
  )
}
