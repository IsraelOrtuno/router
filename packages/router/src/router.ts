import {
  RouteRecordRaw,
  isRouteLocation,
  isRouteName,
  MatcherLocationRaw,
} from './types'
import type {
  RouteLocationRaw,
  RouteParams,
  RouteLocationNormalizedLoaded,
  RouteLocationResolved,
  RouteRecordNameGeneric,
} from './typed-routes'
import { _ScrollPositionNormalized } from './scrollBehavior'
import { _ErrorListener } from './errors'
import { applyToParams, assign, mergeOptions } from './utils'
import { encodeParam, decode, encodeHash } from './encoding'
import {
  normalizeQuery,
  stringifyQuery as originalStringifyQuery,
  LocationQuery,
  parseQuery,
  stringifyQuery,
} from './query'
import { RouteRecordNormalized } from './matcher/types'
import { parseURL, stringifyURL } from './location'
import { warn } from './warning'
import { _LiteralUnion } from './types/utils'
import {
  EXPERIMENTAL_RouteRecordNormalized,
  EXPERIMENTAL_RouteRecordRaw,
  EXPERIMENTAL_RouterOptions_Base,
  EXPERIMENTAL_Router_Base,
  _OnReadyCallback,
  experimental_createRouter,
} from './experimental/router'
import { createCompiledMatcher } from './new-route-resolver'
import {
  NEW_RouterResolver,
  NEW_MatcherRecordRaw,
} from './new-route-resolver/resolver'
import {
  checkChildMissingNameWithEmptyPath,
  normalizeRecordProps,
  normalizeRouteRecord,
  PathParserOptions,
} from './matcher'
import { PATH_PARSER_OPTIONS_DEFAULTS } from './matcher/pathParserRanker'
import {
  createRouteRecordMatcher,
  NEW_createRouteRecordMatcher,
} from './matcher/pathMatcher'

/**
 * Options to initialize a {@link Router} instance.
 */
export interface RouterOptions extends EXPERIMENTAL_RouterOptions_Base {
  /**
   * Initial list of routes that should be added to the router.
   */
  routes: Readonly<RouteRecordRaw[]>
}

/**
 * Router instance.
 */
export interface Router
  extends EXPERIMENTAL_Router_Base<RouteRecordRaw, RouteRecordNormalized> {
  /**
   * Original options object passed to create the Router
   */
  readonly options: RouterOptions
}

/*
 * Normalizes a RouteRecordRaw. Creates a copy
 *
 * @param record
 * @returns the normalized version
 */
export function NEW_normalizeRouteRecord(
  record: RouteRecordRaw & { aliasOf?: RouteRecordNormalized },
  parent?: RouteRecordNormalized
): RouteRecordNormalized {
  let { path } = record
  // Build up the path for nested routes if the child isn't an absolute
  // route. Only add the / delimiter if the child path isn't empty and if the
  // parent path doesn't have a trailing slash
  if (parent && path[0] !== '/') {
    const parentPath = parent.path
    const connectingSlash = parentPath[parentPath.length - 1] === '/' ? '' : '/'
    path = parentPath + (path && connectingSlash + path)
  }

  const normalized: Omit<RouteRecordNormalized, 'mods'> = {
    path,
    redirect: record.redirect,
    name: record.name,
    meta: record.meta || {},
    aliasOf: record.aliasOf,
    beforeEnter: record.beforeEnter,
    props: normalizeRecordProps(record),
    // TODO: normalize children here or outside?
    children: record.children || [],
    instances: {},
    leaveGuards: new Set(),
    updateGuards: new Set(),
    enterCallbacks: {},
    // must be declared afterwards
    // mods: {},
    components:
      'components' in record
        ? record.components || null
        : record.component && { default: record.component },
  }

  // mods contain modules and shouldn't be copied,
  // logged or anything. It's just used for internal
  // advanced use cases like data loaders
  Object.defineProperty(normalized, 'mods', {
    value: {},
  })

  return normalized as RouteRecordNormalized
}

export function compileRouteRecord(
  record: RouteRecordRaw,
  parent?: RouteRecordNormalized,
  originalRecord?: EXPERIMENTAL_RouteRecordNormalized
): EXPERIMENTAL_RouteRecordRaw {
  // used later on to remove by name
  const isRootAdd = !originalRecord
  const options: PathParserOptions = mergeOptions(
    PATH_PARSER_OPTIONS_DEFAULTS,
    record
  )
  const mainNormalizedRecord = NEW_normalizeRouteRecord(record, parent)
  const recordMatcher = NEW_createRouteRecordMatcher(
    mainNormalizedRecord,
    // FIXME: is this needed?
    // @ts-expect-error: the parent is the record not the matcher
    parent,
    options
  )

  recordMatcher.record

  if (__DEV__) {
    // TODO:
    // checkChildMissingNameWithEmptyPath(mainNormalizedRecord, parent)
  }
  // we might be the child of an alias
  // mainNormalizedRecord.aliasOf = originalRecord
  // generate an array of records to correctly handle aliases
  const normalizedRecords: EXPERIMENTAL_RouteRecordNormalized[] = [
    mainNormalizedRecord,
  ]

  if ('alias' in record) {
    const aliases =
      typeof record.alias === 'string' ? [record.alias] : record.alias!
    for (const alias of aliases) {
      normalizedRecords.push(
        // we need to normalize again to ensure the `mods` property
        // being non enumerable
        NEW_normalizeRouteRecord(
          assign({}, mainNormalizedRecord, {
            // this allows us to hold a copy of the `components` option
            // so that async components cache is hold on the original record
            components: originalRecord
              ? originalRecord.record.components
              : mainNormalizedRecord.components,
            path: alias,
            // we might be the child of an alias
            aliasOf: originalRecord
              ? originalRecord.record
              : mainNormalizedRecord,
            // the aliases are always of the same kind as the original since they
            // are defined on the same record
          })
        )
      )
    }
  }

  let matcher: RouteRecordMatcher
  let originalMatcher: RouteRecordMatcher | undefined

  for (const normalizedRecord of normalizedRecords) {
    const { path } = normalizedRecord
    // Build up the path for nested routes if the child isn't an absolute
    // route. Only add the / delimiter if the child path isn't empty and if the
    // parent path doesn't have a trailing slash
    if (parent && path[0] !== '/') {
      const parentPath = parent.record.path
      const connectingSlash =
        parentPath[parentPath.length - 1] === '/' ? '' : '/'
      normalizedRecord.path =
        parent.record.path + (path && connectingSlash + path)
    }

    if (__DEV__ && normalizedRecord.path === '*') {
      throw new Error(
        'Catch all routes ("*") must now be defined using a param with a custom regexp.\n' +
          'See more at https://router.vuejs.org/guide/migration/#Removed-star-or-catch-all-routes.'
      )
    }

    // create the object beforehand, so it can be passed to children
    matcher = createRouteRecordMatcher(normalizedRecord, parent, options)

    if (__DEV__ && parent && path[0] === '/')
      checkMissingParamsInAbsolutePath(matcher, parent)

    // if we are an alias we must tell the original record that we exist,
    // so we can be removed
    if (originalRecord) {
      originalRecord.alias.push(matcher)
      if (__DEV__) {
        checkSameParams(originalRecord, matcher)
      }
    } else {
      // otherwise, the first record is the original and others are aliases
      originalMatcher = originalMatcher || matcher
      if (originalMatcher !== matcher) originalMatcher.alias.push(matcher)

      // remove the route if named and only for the top record (avoid in nested calls)
      // this works because the original record is the first one
      if (isRootAdd && record.name && !isAliasRecord(matcher)) {
        if (__DEV__) {
          checkSameNameAsAncestor(record, parent)
        }
        removeRoute(record.name)
      }
    }

    // Avoid adding a record that doesn't display anything. This allows passing through records without a component to
    // not be reached and pass through the catch all route
    if (isMatchable(matcher)) {
      insertMatcher(matcher)
    }

    if (mainNormalizedRecord.children) {
      const children = mainNormalizedRecord.children
      for (let i = 0; i < children.length; i++) {
        addRoute(
          children[i],
          matcher,
          originalRecord && originalRecord.children[i]
        )
      }
    }

    // if there was no original record, then the first one was not an alias and all
    // other aliases (if any) need to reference this record when adding children
    originalRecord = originalRecord || matcher

    // TODO: add normalized records for more flexibility
    // if (parent && isAliasRecord(originalRecord)) {
    //   parent.children.push(originalRecord)
    // }
  }

  return originalMatcher
    ? () => {
        // since other matchers are aliases, they should be removed by the original matcher
        removeRoute(originalMatcher!)
      }
    : noop
  return {
    name: record.name,
    children: record.children?.map(child => compileRouteRecord(child, record)),
  }
}

/**
 * Creates a Router instance that can be used by a Vue app.
 *
 * @param options - {@link RouterOptions}
 */
export function createRouter(options: RouterOptions): Router {
  const matcher = createCompiledMatcher<EXPERIMENTAL_RouteRecordNormalized>(
    options.routes.map(record => compileRouteRecord(record))
  )

  const router = experimental_createRouter({
    matcher,
    ...options,
    // avoids adding the routes twice
    routes: [],
  })

  return router
}

export function _createRouter(options: RouterOptions): Router {
  const normalizeParams = applyToParams.bind(
    null,
    paramValue => '' + paramValue
  )
  const encodeParams = applyToParams.bind(null, encodeParam)
  const decodeParams: (params: RouteParams | undefined) => RouteParams =
    // @ts-expect-error: intentionally avoid the type check
    applyToParams.bind(null, decode)

  function addRoute(
    parentOrRoute: NonNullable<RouteRecordNameGeneric> | RouteRecordRaw,
    route?: RouteRecordRaw
  ) {
    let parent: Parameters<(typeof matcher)['addRoute']>[1] | undefined
    let record: RouteRecordRaw
    if (isRouteName(parentOrRoute)) {
      parent = matcher.getRecordMatcher(parentOrRoute)
      if (__DEV__ && !parent) {
        warn(
          `Parent route "${String(
            parentOrRoute
          )}" not found when adding child route`,
          route
        )
      }
      record = route!
    } else {
      record = parentOrRoute
    }

    return matcher.addRoute(record, parent)
  }

  function removeRoute(name: NonNullable<RouteRecordNameGeneric>) {
    const recordMatcher = matcher.getRecordMatcher(name)
    if (recordMatcher) {
      matcher.removeRoute(recordMatcher)
    } else if (__DEV__) {
      warn(`Cannot remove non-existent route "${String(name)}"`)
    }
  }

  function resolve(
    rawLocation: RouteLocationRaw,
    currentLocation?: RouteLocationNormalizedLoaded
  ): RouteLocationResolved {
    // const resolve: Router['resolve'] = (rawLocation: RouteLocationRaw, currentLocation) => {
    // const objectLocation = routerLocationAsObject(rawLocation)
    // we create a copy to modify it later
    currentLocation = assign({}, currentLocation || currentRoute.value)
    if (typeof rawLocation === 'string') {
      const locationNormalized = parseURL(
        parseQuery,
        rawLocation,
        currentLocation.path
      )
      const matchedRoute = matcher.resolve(
        { path: locationNormalized.path },
        currentLocation
      )

      const href = routerHistory.createHref(locationNormalized.fullPath)
      if (__DEV__) {
        if (href.startsWith('//'))
          warn(
            `Location "${rawLocation}" resolved to "${href}". A resolved location cannot start with multiple slashes.`
          )
        else if (!matchedRoute.matched.length) {
          warn(`No match found for location with path "${rawLocation}"`)
        }
      }

      // locationNormalized is always a new object
      return assign(locationNormalized, matchedRoute, {
        params: decodeParams(matchedRoute.params),
        hash: decode(locationNormalized.hash),
        redirectedFrom: undefined,
        href,
      })
    }

    if (__DEV__ && !isRouteLocation(rawLocation)) {
      warn(
        `router.resolve() was passed an invalid location. This will fail in production.\n- Location:`,
        rawLocation
      )
      return resolve({})
    }

    let matcherLocation: MatcherLocationRaw

    // path could be relative in object as well
    if (rawLocation.path != null) {
      if (
        __DEV__ &&
        'params' in rawLocation &&
        !('name' in rawLocation) &&
        // @ts-expect-error: the type is never
        Object.keys(rawLocation.params).length
      ) {
        warn(
          `Path "${rawLocation.path}" was passed with params but they will be ignored. Use a named route alongside params instead.`
        )
      }
      matcherLocation = assign({}, rawLocation, {
        path: parseURL(parseQuery, rawLocation.path, currentLocation.path).path,
      })
    } else {
      // remove any nullish param
      const targetParams = assign({}, rawLocation.params)
      for (const key in targetParams) {
        if (targetParams[key] == null) {
          delete targetParams[key]
        }
      }
      // pass encoded values to the matcher, so it can produce encoded path and fullPath
      matcherLocation = assign({}, rawLocation, {
        params: encodeParams(targetParams),
      })
      // current location params are decoded, we need to encode them in case the
      // matcher merges the params
      currentLocation.params = encodeParams(currentLocation.params)
    }

    const matchedRoute = matcher.resolve(matcherLocation, currentLocation)
    const hash = rawLocation.hash || ''

    if (__DEV__ && hash && !hash.startsWith('#')) {
      warn(
        `A \`hash\` should always start with the character "#". Replace "${hash}" with "#${hash}".`
      )
    }

    // the matcher might have merged current location params, so
    // we need to run the decoding again
    matchedRoute.params = normalizeParams(decodeParams(matchedRoute.params))

    const fullPath = stringifyURL(
      stringifyQuery,
      assign({}, rawLocation, {
        hash: encodeHash(hash),
        path: matchedRoute.path,
      })
    )

    const href = routerHistory.createHref(fullPath)
    if (__DEV__) {
      if (href.startsWith('//')) {
        warn(
          `Location "${rawLocation}" resolved to "${href}". A resolved location cannot start with multiple slashes.`
        )
      } else if (!matchedRoute.matched.length) {
        warn(
          `No match found for location with path "${
            rawLocation.path != null ? rawLocation.path : rawLocation
          }"`
        )
      }
    }

    return assign(
      {
        fullPath,
        // keep the hash encoded so fullPath is effectively path + encodedQuery +
        // hash
        hash,
        query:
          // if the user is using a custom query lib like qs, we might have
          // nested objects, so we keep the query as is, meaning it can contain
          // numbers at `$route.query`, but at the point, the user will have to
          // use their own type anyway.
          // https://github.com/vuejs/router/issues/328#issuecomment-649481567
          stringifyQuery === originalStringifyQuery
            ? normalizeQuery(rawLocation.query)
            : ((rawLocation.query || {}) as LocationQuery),
      },
      matchedRoute,
      {
        redirectedFrom: undefined,
        href,
      }
    )
  }
}
