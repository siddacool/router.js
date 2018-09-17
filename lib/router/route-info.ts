import { Promise } from 'rsvp';
import { Dict } from './core';
import Router, { GetHandlerFunc, SerializerFunc } from './router';
import { isTransition, prepareResult, Transition } from './transition';
import { isParam, isPromise, merge } from './utils';

interface IModel {
  id?: string | number;
}

const stubHandler = {
  _handlerName: '',
  context: undefined,
  handler: '',
  names: [],
};

export const noopGetHandler = () => {
  return Promise.resolve<Route>(stubHandler);
};

export interface HandlerInfoArgs {
  name: string;
  handler?: any;
}

export interface HandlerHooks {
  model?(
    params: Dict<unknown>,
    transition: Transition
  ): Promise<Dict<unknown> | null | undefined> | undefined | Dict<unknown>;
  deserialize?(params: Dict<unknown>, transition: Transition): Dict<unknown>;
  serialize?(model: Dict<unknown>, params: string[]): Dict<unknown>;
  beforeModel?(transition: Transition): Promise<Dict<unknown> | null | undefined> | undefined;
  afterModel?(
    resolvedModel: Dict<unknown>,
    transition: Transition
  ): Promise<Dict<unknown> | null | undefined>;
  setup?(context: Dict<unknown>, transition: Transition): void;
  enter?(transition: Transition): void;
  exit?(transition?: Transition): void;
  reset?(wasReset: boolean, transition?: Transition): void;
  contextDidChange?(): void;
  // Underscore methods for some reason
  redirect?(context: Dict<unknown>, transition: Transition): void;
  _model?(
    params: Dict<unknown>,
    transition: Transition
  ): Promise<Dict<unknown> | null | undefined> | undefined | Dict<unknown>;
  _deserialize?(params: Dict<unknown>, transition: Transition): Dict<unknown>;
  _serialize?(model: Dict<unknown>, params: string[]): Dict<unknown>;
  _beforeModel?(transition: Transition): Promise<Dict<unknown> | null | undefined> | undefined;
  _afterModel?(
    resolvedModel: Dict<unknown>,
    transition: Transition
  ): Promise<Dict<unknown> | null | undefined>;
  _setup?(context: Dict<unknown>, transition: Transition): void;
  _enter?(transition: Transition): void;
  _exit?(transition?: Transition): void;
  _reset?(wasReset: boolean, transition?: Transition): void;
  _contextDidChange?(): void;
  _redirect?(context: Dict<unknown>, transition: Transition): void;
}

export interface Route extends HandlerHooks {
  inaccessibleByURL?: boolean;
  routeName: string;
  context: unknown;
  names: string[];
  name?: string;
  handler: string;
  events?: Dict<Function>;
}

export type Continuation = () => PromiseLike<boolean> | boolean;

export interface IResolvedModel {
  [key: string]: unknown;
}

// class RouteInfo {
//   constructor(
//     routeName: string,
//     childRoute: unknown,
//     params: Dict<unknown>,
//     queryParams: Dict<unknown>,
//     data: Dict<unknown>
//   ) {}
// }

export default abstract class PrivateRouteInfo {
  private _routePromise?: Promise<Route> = undefined;
  private _route?: Route = undefined;
  protected router: Router;
  name: string;
  params: Dict<unknown> = {};
  queryParams?: Dict<unknown>;
  context?: Dict<unknown>;
  isResolved = false;

  constructor(name: string, router: Router, route?: Route) {
    this.name = name;
    this.router = router;
    if (route) {
      this._processRoute(route);
    }
  }

  abstract getModel(transition: Transition): Promise<Dict<unknown> | undefined> | Dict<unknown>;

  serialize(_context?: Dict<unknown>) {
    return this.params || {};
  }

  resolve(shouldContinue: Continuation, transition: Transition): Promise<ResolvedRouteInfo> {
    return Promise.resolve(this.routePromise)
      .then((handler: Route) => this.checkForAbort(shouldContinue, handler), null)
      .then(() => {
        return this.runBeforeModelHook(transition);
      }, null)
      .then(() => this.checkForAbort(shouldContinue, null), null)
      .then(() => this.getModel(transition))
      .then(resolvedModel => this.checkForAbort(shouldContinue, resolvedModel), null)
      .then(resolvedModel => this.runAfterModelHook(transition, resolvedModel))
      .then(resolvedModel => this.becomeResolved(transition, resolvedModel));
  }

  becomeResolved(transition: Transition | null, resolvedContext: Dict<unknown>): ResolvedRouteInfo {
    let params = this.serialize(resolvedContext);

    if (transition) {
      this.stashResolvedModel(transition, resolvedContext);
      transition.params = transition.params || {};
      transition.params[this.name] = params;
    }

    let context;
    let contextsMatch = resolvedContext === this.context;

    if ('context' in this || !contextsMatch) {
      context = resolvedContext;
    }

    return new ResolvedRouteInfo(this.name, this.router, this.route!, params, context);
  }

  shouldSupercede(routeInfo?: PrivateRouteInfo) {
    // Prefer this newer handlerInfo over `other` if:
    // 1) The other one doesn't exist
    // 2) The names don't match
    // 3) This handler has a context that doesn't match
    //    the other one (or the other one doesn't have one).
    // 4) This handler has parameters that don't match the other.
    if (!routeInfo) {
      return true;
    }

    let contextsMatch = routeInfo.context === this.context;
    return (
      routeInfo.name !== this.name ||
      ('context' in this && !contextsMatch) ||
      (this.hasOwnProperty('params') && !paramsMatch(this.params, routeInfo.params))
    );
  }

  get route(): Route | undefined {
    // _handler could be set to either a handler object or undefined, so we
    // compare against a default reference to know when it's been set
    if (this._route !== undefined) {
      return this._route!;
    }

    return this.fetchRoute();
  }

  set route(route: Route | undefined) {
    this._route = route;
  }

  get routePromise(): Promise<Route> {
    if (this._routePromise) {
      return this._routePromise;
    }

    this.fetchRoute();

    return this._routePromise!;
  }

  set routePromise(handlerPromise: Promise<Route>) {
    this._routePromise = handlerPromise;
  }

  protected log(transition: Transition, message: string) {
    if (transition.log) {
      transition.log(this.name + ': ' + message);
    }
  }

  private updateRoute(route: Route) {
    // Store the name of the handler on the handler for easy checks later
    route.routeName = this.name;
    return (this.route = route);
  }

  private runBeforeModelHook(transition: Transition) {
    if (transition.trigger) {
      transition.trigger(true, 'willResolveModel', transition, this.route);
    }

    let result;
    if (this.route) {
      if (this.route._beforeModel !== undefined) {
        result = this.route._beforeModel(transition);
      } else if (this.route.beforeModel !== undefined) {
        result = this.route.beforeModel(transition);
      }
    }

    if (isTransition(result)) {
      result = null;
    }

    return Promise.resolve(result);
  }

  private runAfterModelHook(
    transition: Transition,
    resolvedModel?: Dict<unknown>
  ): Promise<Dict<unknown>> {
    // Stash the resolved model on the payload.
    // This makes it possible for users to swap out
    // the resolved model in afterModel.
    let name = this.name;
    this.stashResolvedModel(transition, resolvedModel!);

    let result;
    if (this.route !== undefined) {
      if (this.route._afterModel !== undefined) {
        result = this.route._afterModel(resolvedModel!, transition);
      } else if (this.route.afterModel !== undefined) {
        result = this.route.afterModel(resolvedModel!, transition);
      }
    }

    result = prepareResult(result);

    return Promise.resolve(result).then(() => {
      // Ignore the fulfilled value returned from afterModel.
      // Return the value stashed in resolvedModels, which
      // might have been swapped out in afterModel.
      return transition.resolvedModels[name]!;
    });
  }

  private checkForAbort<T>(shouldContinue: Continuation, value: T) {
    return Promise.resolve(shouldContinue()).then(function() {
      // We don't care about shouldContinue's resolve value;
      // pass along the original value passed to this fn.
      return value;
    }, null);
  }

  private stashResolvedModel(transition: Transition, resolvedModel?: Dict<unknown>) {
    transition.resolvedModels = transition.resolvedModels || {};
    transition.resolvedModels[this.name] = resolvedModel;
  }

  private fetchRoute() {
    let route = this.router.getRoute(this.name);
    return this._processRoute(route);
  }

  private _processRoute(route: Route | Promise<Route>) {
    // Setup a routePromise so that we can wait for asynchronously loaded handlers
    this.routePromise = Promise.resolve(route);

    // Wait until the 'route' property has been updated when chaining to a route
    // that is a promise
    if (isPromise(route)) {
      this.routePromise = this.routePromise.then(h => {
        return this.updateRoute(h);
      });
      // set to undefined to avoid recursive loop in the route getter
      return (this.route = undefined);
    } else if (route) {
      return this.updateRoute(route);
    }

    return undefined;
  }
}

export class ResolvedRouteInfo extends PrivateRouteInfo {
  isResolved: boolean;
  constructor(
    name: string,
    router: Router,
    handler: Route,
    params: Dict<unknown>,
    context?: Dict<unknown>
  ) {
    super(name, router, handler);
    this.params = params;
    this.isResolved = true;
    this.context = context;
  }

  resolve(_shouldContinue?: Continuation, transition?: Transition): Promise<this> {
    // A ResolvedHandlerInfo just resolved with itself.
    if (transition && transition.resolvedModels) {
      transition.resolvedModels[this.name] = this.context!;
    }
    return Promise.resolve<this>(this);
  }
}

export class UnresolvedHandlerInfoByParam extends PrivateRouteInfo {
  params: Dict<unknown> = {};
  constructor(name: string, router: Router, params: Dict<unknown>, route?: Route) {
    super(name, router, route);
    this.params = params;
  }

  getModel(transition: Transition) {
    let fullParams = this.params;
    if (transition && transition.queryParams) {
      fullParams = {};
      merge(fullParams, this.params);
      fullParams.queryParams = transition.queryParams;
    }

    let handler = this.route!;

    let result: Dict<unknown> | undefined = undefined;

    if (handler._deserialize) {
      result = handler._deserialize(fullParams, transition);
    } else if (handler.deserialize) {
      result = handler.deserialize(fullParams, transition);
    } else if (handler._model) {
      result = handler._model(fullParams, transition);
    } else if (handler.model) {
      result = handler.model(fullParams, transition);
    }

    if (result && isTransition(result)) {
      result = undefined;
    }

    return Promise.resolve(result);
  }
}

export class UnresolvedHandlerInfoByObject extends PrivateRouteInfo {
  names: string[] = [];
  serializer?: SerializerFunc;
  constructor(name: string, names: string[], router: Router, context: Dict<unknown>) {
    super(name, router);
    this.names = names;
    this.context = context;
    this.names = this.names || [];
    this.serializer = this.router.getSerializer(name);
  }

  getModel(transition: Transition) {
    this.log(transition, this.name + ': resolving provided model');
    return Promise.resolve(this.context);
  }

  /**
    @private

    Serializes a handler using its custom `serialize` method or
    by a default that looks up the expected property name from
    the dynamic segment.

    @param {Object} model the model to be serialized for this handler
  */
  serialize(model?: IModel) {
    let { names, context } = this;

    if (!model) {
      model = context as IModel;
    }

    let object: Dict<unknown> = {};
    if (isParam(model)) {
      object[names[0]] = model;
      return object;
    }

    // Use custom serialize if it exists.
    if (this.serializer) {
      // invoke this.serializer unbound (getSerializer returns a stateless function)
      return this.serializer.call(null, model, names);
    } else if (this.route !== undefined) {
      if (this.route._serialize) {
        return this.route._serialize(model, names);
      }

      if (this.route.serialize) {
        return this.route.serialize(model, names);
      }
    }

    if (names.length !== 1) {
      return;
    }

    let name = names[0];

    if (/_id$/.test(name)) {
      object[name] = model.id;
    } else {
      object[name] = model;
    }
    return object;
  }
}

function paramsMatch(a: Dict<unknown>, b: Dict<unknown>) {
  if (!a !== !b) {
    // Only one is null.
    return false;
  }

  if (!a) {
    // Both must be null.
    return true;
  }

  // Note: this assumes that both params have the same
  // number of keys, but since we're comparing the
  // same handlers, they should.
  for (let k in a) {
    if (a.hasOwnProperty(k) && a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}
