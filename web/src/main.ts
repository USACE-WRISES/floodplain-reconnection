// The page's start: the app, its data sources (config.ts) and, with ?debug=1, a handle for the console.
import { App } from './app/app'
import { dataBase, stafBase } from './config'

const params = new URLSearchParams(location.search)
const app = new App(params, dataBase(params), stafBase(params))
void app.start()
if (params.get('debug') === '1') (window as unknown as { fprApp: App }).fprApp = app
