import { createBrowserRouter } from 'react-router'
import { Layout } from '../components/Layout'
import { Home } from '../pages/Home'
import { Receive } from '../pages/Receive'
import { Send } from '../pages/Send'
import { Settings } from '../pages/Settings'
import { Activity } from '../pages/Activity'
import { Advanced } from '../pages/Advanced'
import { Peers } from '../pages/Peers'
import { Backup } from '../pages/Backup'
import { OpenChannel } from '../pages/OpenChannel'
import { CloseChannel } from '../pages/CloseChannel'

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
      { path: 'settings/backup', element: <Backup /> },
      { path: 'settings/advanced', element: <Advanced /> },
      { path: 'settings/advanced/peers', element: <Peers /> },
      { path: 'settings/advanced/open-channel', element: <OpenChannel /> },
      { path: 'settings/advanced/close-channel', element: <CloseChannel /> },
    ],
  },
])
