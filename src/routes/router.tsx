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
import { Balance } from '../pages/Balance'
import { Scan } from '../pages/Scan'
import { Restore } from '../pages/Restore'
import { TransactionDetail } from '../pages/TransactionDetail'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'receive', element: <Receive /> },
      { path: 'send', element: <Send /> },
      { path: 'scan', element: <Scan /> },
      { path: 'activity', element: <Activity /> },
      { path: 'activity/:txId', element: <TransactionDetail /> },
      { path: 'settings', element: <Settings /> },
      { path: 'settings/backup', element: <Backup /> },
      { path: 'settings/restore', element: <Restore /> },
      { path: 'settings/advanced', element: <Advanced /> },
      { path: 'settings/advanced/balance', element: <Balance /> },
      { path: 'settings/advanced/peers', element: <Peers /> },
      { path: 'settings/advanced/peers/open-channel', element: <OpenChannel /> },
      { path: 'settings/advanced/peers/close-channel', element: <CloseChannel /> },
    ],
  },
])
