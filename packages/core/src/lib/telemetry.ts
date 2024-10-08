import { platform } from 'node:os'
import https from 'node:https'

import ci from 'ci-info'
import Conf from 'conf'
import {
  bold,
  yellow as y,
  red as r,
  green as g
} from 'chalk'
import {
  type Configuration,
  type Device,
  type PackageName,
  type Project,
  type TelemetryVersion1,
  type TelemetryVersion2and3,
} from '../types/telemetry'
import { type DatabaseProvider } from '../types'
import { type InitialisedList } from './core/initialise-lists'

const defaultTelemetryEndpoint = 'https://telemetry.keystonejs.com'

const packageNames: PackageName[] = [
  '@keystone-6/core',
  '@keystone-6/auth',
  '@keystone-6/fields-document',
  '@keystone-6/cloudinary',
  '@keystone-6/session-store-redis',
  '@opensaas/keystone-nextjs-auth',
]

function log (message: unknown) {
  if (process.env.KEYSTONE_TELEMETRY_DEBUG === '1') {
    console.log(`${message}`)
  }
}

function getTelemetryConfig () {
  const userConfig = new Conf<Configuration>({
    projectName: 'keystonejs',
    projectSuffix: '',
    projectVersion: '3.0.0',
    migrations: {
      '^2.0.0': (store) => {
        const existing = store.get('telemetry') as TelemetryVersion1
        if (!existing) return // skip non-configured or known opt-outs

        const replacement: TelemetryVersion2and3 = {
          informedAt: null, // re-inform
          device: {
            lastSentDate: existing.device.lastSentDate ?? null,
          },
          projects: {}, // see below
        }

        // copy existing project lastSentDate's
        for (const [projectPath, project] of Object.entries(existing.projects)) {
          if (projectPath === 'default') continue // informedAt moved to device.lastSentDate

          // dont copy garbage
          if (typeof project !== 'object') continue
          if (typeof project.lastSentDate !== 'string') continue
          if (new Date(project.lastSentDate).toString() === 'Invalid Date') continue

          // retain lastSentDate
          replacement.projects[projectPath] = {
            lastSentDate: project.lastSentDate,
          }
        }

        store.set('telemetry', replacement)
      },
      '^3.0.0': (store) => {
        const existing = store.get('telemetry') as TelemetryVersion2and3
        if (!existing) return // skip non-configured or known opt-outs

        store.set('telemetry', {
          ...existing,
          informedAt: null, // re-inform
        } satisfies TelemetryVersion2and3)
      },
    },
  })

  return {
    telemetry: userConfig.get('telemetry'),
    userConfig,
  }
}

function getDefaultedTelemetryConfig () {
  const { telemetry, userConfig } = getTelemetryConfig()

  if (telemetry === undefined) {
    return {
      telemetry: {
        informedAt: null,
        device: {
          lastSentDate: null,
        },
        projects: {},
      } as TelemetryVersion2and3, // help Typescript infer the type
      userConfig,
    }
  }

  return { telemetry, userConfig }
}

const todaysDate = new Date().toISOString().slice(0, 10)

function collectFieldCount (lists: Record<string, InitialisedList>) {
  const fields: Project['fields'] = { unknown: 0 }

  for (const list of Object.values(lists)) {
    for (const [fieldPath, field] of Object.entries(list.fields)) {
      const fieldType = field.__ksTelemetryFieldTypeName
      if (!fieldType) {
        // skip id fields
        if (fieldPath.endsWith('id')) continue
        fields.unknown++
        continue
      }

      fields[fieldType] ||= 0
      fields[fieldType] += 1
    }
  }

  return fields
}

function collectPackageVersions () {
  const versions: Project['versions'] = {
    '@keystone-6/core': '0.0.0', // effectively unknown
  }

  for (const packageName of packageNames) {
    try {
      const packageJson = require(`${packageName}/package.json`)
      versions[packageName] = packageJson.version
    } catch {
      // do nothing, most likely because the package is not installed
    }
  }

  return versions
}

function printAbout () {
  console.log(`${y`Keystone collects anonymous data when you run`} ${g`"keystone dev"`}`)
  console.log()
  console.log(`For more information, including how to opt-out see https://keystonejs.com/telemetry`)
}

export function printTelemetryStatus () {
  const { telemetry } = getTelemetryConfig()

  if (telemetry === undefined) {
    console.log(`Keystone telemetry has been reset to ${y`uninitialized`}`)
    console.log()
    console.log(`Telemetry will be sent the next time you run ${g`"keystone dev"`}, unless you opt-out`)
    return
  }

  if (telemetry === false) {
    console.log(`Keystone telemetry is ${r`disabled`}`)
    console.log()
    console.log(`Telemetry will ${r`not`} be sent by this system user`)
    return
  }

  console.log(`Keystone telemetry is ${g`enabled`}`)
  console.log()

  console.log(`  Device telemetry was last sent on ${telemetry.device.lastSentDate}`)
  for (const [projectPath, project] of Object.entries(telemetry.projects)) {
    console.log(`  Project telemetry for "${y(projectPath)}" was last sent on ${project?.lastSentDate}`)
  }

  console.log()
  console.log(`Telemetry will be sent the next time you run ${g`"keystone dev"`}, unless you opt-out`)
}

function inform () {
  const { telemetry, userConfig } = getDefaultedTelemetryConfig()

  // no telemetry? somehow our earlier missed something, do nothing
  if (!telemetry) return

  console.log() // gap to help visiblity
  console.log(`${bold('Keystone Telemetry')}`)
  printAbout()
  console.log(`You can use ${g`"keystone telemetry --help"`} to update your preferences at any time`)
  console.log()
  console.log(`No telemetry data has been sent, but telemetry will be sent the next time you run ${g`"keystone dev"`}, unless you opt-out`)
  console.log() // gap to help visiblity

  // update the informedAt
  telemetry.informedAt = new Date().toJSON()
  userConfig.set('telemetry', telemetry)
}

async function sendEvent (eventType: 'project' | 'device', eventData: Project | Device) {
  const endpoint = process.env.KEYSTONE_TELEMETRY_ENDPOINT || defaultTelemetryEndpoint
  const req = https.request(`${endpoint}/2/event/${eventType}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  })

  req.end(JSON.stringify(eventData))
  log(`sent ${eventType} report`)
}

async function sendProjectTelemetryEvent (
  cwd: string,
  lists: Record<string, InitialisedList>,
  dbProviderName: DatabaseProvider
) {
  const { telemetry, userConfig } = getDefaultedTelemetryConfig()

  // no telemetry? somehow our earlier missed something, do nothing
  if (!telemetry) return

  const project = telemetry.projects[cwd] ?? { lastSentDate: null }
  const { lastSentDate } = project
  if (lastSentDate && lastSentDate >= todaysDate) {
    log('project telemetry already sent today')
    return
  }

  await sendEvent('project', {
    previous: lastSentDate,
    fields: collectFieldCount(lists),
    lists: Object.keys(lists).length,
    versions: collectPackageVersions(),
    database: dbProviderName,
  })

  // update the project lastSentDate
  telemetry.projects[cwd] = { lastSentDate: todaysDate }
  userConfig.set('telemetry', telemetry)
}

async function sendDeviceTelemetryEvent () {
  const { telemetry, userConfig } = getDefaultedTelemetryConfig()

  // no telemetry? somehow our earlier missed something, do nothing
  if (!telemetry) return

  const { lastSentDate } = telemetry.device
  if (lastSentDate && lastSentDate >= todaysDate) {
    log('device telemetry already sent today')
    return
  }

  await sendEvent('device', {
    previous: lastSentDate,
    os: platform(),
    node: process.versions.node.split('.')[0],
  })

  // update the device lastSentDate
  telemetry.device = { lastSentDate: todaysDate }
  userConfig.set('telemetry', telemetry)
}

export async function runTelemetry (
  cwd: string,
  lists: Record<string, InitialisedList>,
  dbProviderName: DatabaseProvider
) {
  try {
    if (
      ci.isCI || // don't run in CI
      process.env.NODE_ENV === 'production' || // don't run in production
      process.env.KEYSTONE_TELEMETRY_DISABLED === '1' // don't run if the user has disabled it
    ) {
      return
    }

    const { telemetry } = getDefaultedTelemetryConfig()

    // don't run if the user has opted out
    //   or if somehow our defaults are problematic, do nothing
    if (!telemetry) return

    // don't send telemetry before we inform the user, allowing opt-out
    if (!telemetry.informedAt) return inform()

    await sendProjectTelemetryEvent(cwd, lists, dbProviderName)
    await sendDeviceTelemetryEvent()
  } catch (err) {
    log(err)
  }
}

export function enableTelemetry () {
  const { telemetry, userConfig } = getTelemetryConfig()
  if (telemetry === false) {
    userConfig.delete('telemetry')
  }
  printTelemetryStatus()
}

export function disableTelemetry () {
  const { userConfig } = getTelemetryConfig()
  userConfig.set('telemetry', false)
  printTelemetryStatus()
}

export function resetTelemetry () {
  const { userConfig } = getTelemetryConfig()
  userConfig.delete('telemetry')
  printTelemetryStatus()
}
