import { Outlet, Link } from 'react-router'

export function Layout() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
      <nav className="flex gap-4 border-b border-gray-200 p-4 dark:border-gray-700">
        <Link to="/" className="font-medium hover:underline">
          Home
        </Link>
        <Link to="/settings" className="font-medium hover:underline">
          Settings
        </Link>
      </nav>
      <main className="p-4">
        <Outlet />
      </main>
    </div>
  )
}
