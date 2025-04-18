import { channel, client, onCancel } from '@vitest/browser/client'
import { page, server, userEvent } from '@vitest/browser/context'
import {
  collectTests,
  setupCommonEnv,
  SpyModule,
  startCoverageInsideWorker,
  startTests,
  stopCoverageInsideWorker,
} from 'vitest/browser'
import { executor, getBrowserState, getConfig, getWorkerState } from '../utils'
import { setupDialogsSpy } from './dialog'
import { setupConsoleLogSpy } from './logger'
import { VitestBrowserClientMocker } from './mocker'
import { createModuleMockerInterceptor } from './mocker-interceptor'
import { createSafeRpc } from './rpc'
import { browserHashMap, initiateRunner } from './runner'
import { CommandsManager } from './utils'

const cleanupSymbol = Symbol.for('vitest:component-cleanup')

const url = new URL(location.href)
const reloadStart = url.searchParams.get('__reloadStart')

function debug(...args: unknown[]) {
  const debug = getConfig().env.VITEST_BROWSER_DEBUG
  if (debug && debug !== 'false') {
    client.rpc.debug(...args.map(String))
  }
}

async function prepareTestEnvironment(files: string[]) {
  debug('trying to resolve runner', `${reloadStart}`)
  const config = getConfig()

  const rpc = createSafeRpc(client)

  const state = getWorkerState()

  state.ctx.files = files
  state.onCancel = onCancel
  state.rpc = rpc as any

  getBrowserState().commands = new CommandsManager()

  const interceptor = createModuleMockerInterceptor()
  const mocker = new VitestBrowserClientMocker(
    interceptor,
    rpc,
    SpyModule.spyOn,
    {
      root: getBrowserState().viteConfig.root,
    },
  )
  // @ts-expect-error mocking vitest apis
  globalThis.__vitest_mocker__ = mocker

  setupConsoleLogSpy()
  setupDialogsSpy()

  const runner = await initiateRunner(state, mocker, config)
  getBrowserState().runner = runner

  const version = url.searchParams.get('browserv') || ''
  files.forEach((filename) => {
    const currentVersion = browserHashMap.get(filename)
    if (!currentVersion || currentVersion[1] !== version) {
      browserHashMap.set(filename, version)
    }
  })

  onCancel.then((reason) => {
    runner.onCancel?.(reason)
  })

  return {
    runner,
    config,
    state,
    rpc,
    commands: getBrowserState().commands,
  }
}

function done(files: string[]) {
  channel.postMessage({
    type: 'done',
    filenames: files,
    id: getBrowserState().iframeId!,
  })
}

async function executeTests(method: 'run' | 'collect', files: string[]) {
  await client.waitForConnection()

  debug('client is connected to ws server')

  let preparedData:
    | Awaited<ReturnType<typeof prepareTestEnvironment>>
    | undefined
    | false

  // if importing /@id/ failed, we reload the page waiting until Vite prebundles it
  try {
    preparedData = await prepareTestEnvironment(files)
  }
  catch (error: any) {
    debug('runner cannot be loaded because it threw an error', error.stack || error.message)
    await client.rpc.onUnhandledError({
      name: error.name,
      message: error.message,
      stack: String(error.stack),
    }, 'Preload Error')
    done(files)
    return
  }

  // page is reloading
  if (!preparedData) {
    debug('page is reloading, waiting for the next run')
    return
  }

  debug('runner resolved successfully')

  const { config, runner, state, commands, rpc } = preparedData

  state.durations.prepare = performance.now() - state.durations.prepare

  debug('prepare time', state.durations.prepare, 'ms')

  let contextSwitched = false

  // webdiverio context depends on the iframe state, so we need to switch the context,
  // we delay this in case the user doesn't use any userEvent commands to avoid the overhead
  if (server.provider === 'webdriverio') {
    let switchPromise: Promise<void> | null = null

    commands.onCommand(async () => {
      if (switchPromise) {
        await switchPromise
      }
      // if this is the first command, make sure we switched the command context to an iframe
      if (!contextSwitched) {
        switchPromise = rpc.wdioSwitchContext('iframe').finally(() => {
          switchPromise = null
          contextSwitched = true
        })
        await switchPromise
      }
    })
  }

  try {
    await Promise.all([
      setupCommonEnv(config),
      startCoverageInsideWorker(config.coverage, executor, { isolate: config.browser.isolate }),
      (async () => {
        const VitestIndex = await import('vitest')
        Object.defineProperty(window, '__vitest_index__', {
          value: VitestIndex,
          enumerable: false,
        })
      })(),
    ])

    for (const file of files) {
      state.filepath = file

      if (method === 'run') {
        await startTests([file], runner)
      }
      else {
        await collectTests([file], runner)
      }
    }
  }
  finally {
    try {
      if (cleanupSymbol in page) {
        (page[cleanupSymbol] as any)()
      }
      // need to cleanup for each tester
      // since playwright keyboard API is stateful on page instance level
      await userEvent.cleanup()
      if (contextSwitched) {
        await rpc.wdioSwitchContext('parent')
      }
    }
    catch (error: any) {
      await client.rpc.onUnhandledError({
        name: error.name,
        message: error.message,
        stack: String(error.stack),
      }, 'Cleanup Error')
    }
    state.environmentTeardownRun = true
    await stopCoverageInsideWorker(config.coverage, executor, { isolate: config.browser.isolate }).catch((error) => {
      client.rpc.onUnhandledError({
        name: error.name,
        message: error.message,
        stack: String(error.stack),
      }, 'Coverage Error').catch(() => {})
    })

    debug('finished running tests')
    done(files)
  }
}

// @ts-expect-error untyped global for internal use
window.__vitest_browser_runner__.runTests = files => executeTests('run', files)
// @ts-expect-error untyped global for internal use
window.__vitest_browser_runner__.collectTests = files => executeTests('collect', files)
