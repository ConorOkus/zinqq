import { Outlet } from 'react-router'
import { TabBar } from './TabBar'

export function Layout() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[430px] flex-col">
      <Outlet />
      <TabBar />
    </div>
  )
}
