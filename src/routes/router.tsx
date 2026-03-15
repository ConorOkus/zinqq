import { createBrowserRouter } from 'react-router'
import { Layout } from '../components/Layout'
import { Home } from '../pages/Home'
import { Receive } from '../pages/Receive'
import { Send } from '../pages/Send'
import { Settings } from '../pages/Settings'
import { Activity } from '../pages/Activity'
import { Advanced } from '../pages/Advanced'
import { Peers } from '../pages/Peers'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'receive', element: <Receive /> },
      { path: 'send', element: <Send /> },
      { path: 'activity', element: <Activity /> },
      { path: 'settings', element: <Settings /> },
      { path: 'settings/advanced', element: <Advanced /> },
      { path: 'settings/advanced/peers', element: <Peers /> },
    ],
  },
])
