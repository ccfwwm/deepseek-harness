/**
 * Real-process half of the Win32 dialog driver: spawn the dialog child
 * process (source or built plane) and close a dialog thread's windows. The
 * module itself loads everywhere (the import chain from native-picker.ts is
 * static); what stays win32-only is koffi, imported dynamically inside the
 * bindings' functions. The driver's logic is tested against fakes of this
 * surface instead.
 */

import { spawn, type StdioOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { delimiter, join } from 'node:path'
import type { Win32DialogWorkerData } from './win32-dialog-worker.ts'

/**
 * Spawn the dialog child process. Built consumers launch the bundled CJS
 * entry next to this module under plain node; unbuilt (source) consumers
 * bootstrap tsx first, mirroring the dsh CLI's source launch. The dialog is
 * the child's first window, so Windows activates it without a foreground
 * call.
 * @param data - the child payload (dialog title).
 * @returns the spawned child process.
 */
export function spawnDialogWorker(data: Win32DialogWorkerData): ReturnType<typeof spawn> {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? process.cwd()
  const nodeModules = [join(resources, 'app.asar', 'node_modules'), join(resources, 'app.asar.unpacked', 'node_modules'), process.env.NODE_PATH].filter((value): value is string => Boolean(value && value.trim()))
  const env = {
    ...process.env,
    DSH_DIALOG_TITLE: data.title,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: nodeModules.join(delimiter),
    // Electron's executable is a Node-compatible process only when this flag
    // is present. Without it the packaged worker exits before COM startup.
    ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
  }
  const stdio: StdioOptions = ['ignore', 'inherit', 'pipe', 'ipc']
  /* v8 ignore next 3 -- the built-output arm: tests always run unbuilt (src/) */
  if (!import.meta.url.endsWith('.ts')) {
    const workerUrl = new URL('./worker.cjs', import.meta.url)
    const workerPath = fileURLToPath(workerUrl).replace(/app\.asar([\\/])/u, 'app.asar.unpacked$1')
    const child = spawn(process.execPath, [workerPath], { env, stdio, windowsHide: true })
    child.stderr?.on('data', chunk => process.stderr.write(`[directory-picker] ${String(chunk)}`))
    return child
  }
  return spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./win32-dialog-worker.ts', import.meta.url))], { env, stdio, windowsHide: true })
}

export { closeThreadWindows } from './win32-dialog-bindings.ts'
