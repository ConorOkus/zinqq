import { createBrowserRouter } from 'react-router'
import { Layout } from '../components/Layout'
import { Home } from '../pages/Home'
import { Receive } from '../pages/Receive'
import { Send } from '../pages/Send'
import { Settings } from '../pages/Settings'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'receive', element: <Receive /> },
      { path: 'send', element: <Send /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
])
