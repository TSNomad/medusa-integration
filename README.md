# @tsnomad/medusa-integration

TS Nomad strategies for a [Medusa](https://medusajs.com) 2 application,
and the bootstrap that builds one TS Nomad container per process from
Medusa's app container. This is the TypeScript counterpart to PHPNomad's
[wordpress-integration](https://github.com/phpnomad/wordpress-integration)
package: it knows Medusa and TS Nomad, and nothing about any one
application.

| Class | Implements | Medusa piece it uses |
|---|---|---|
| `MedusaActionBindingStrategy` | `ActionBindingStrategy` | subscribers |
| `MedusaRestStrategy` | `RestStrategy` | API routes |
| `MedusaTaskStrategy` | `TaskStrategy` | the event bus module |
| `MedusaLoggerStrategy` | `LoggerStrategy` | the `logger` registration |
| `MedusaInitializer` | `HasClassDefinitions` | none, it binds the strategies |
| `MedusaBootstrap` | none | the app container |

`MedusaInitializer` also binds `InMemoryEventStrategy`,
`NativeFetchStrategy` and `NodeResponseFactory` from
`@tsnomad/node-integration`.

## Install

```bash
npm install @tsnomad/medusa-integration
```

The package ships compiled JavaScript with its type declarations, so
it needs no build step of its own. It needs Node 20.19 or later.
npm installs the TS Nomad packages it depends on with it.
Medusa itself is an optional peer dependency. See Medusa versions below.

`scripts/consumer-check.sh [<commit>]` installs the package from git at
one commit into a scratch project and imports every export, from Node
and from TypeScript.

## Where it fits

This is the integration layer for a Medusa application, and the top of
the TS Nomad stack. It depends on the container, event and loader
packages, on the `@tsnomad/http`, `@tsnomad/logger`, `@tsnomad/fetch`,
`@tsnomad/tasks` and `@tsnomad/rest` contracts, and on
`@tsnomad/node-integration` for the strategies that need only Node.

## Use

Create one bootstrap in a module that every subscriber, job and route
file imports, so the whole process shares it. One bootstrap serves the
whole Medusa application, plugins included, since task event names are
shared by the application's event bus:

```ts
// src/tsnomad.ts
import { MedusaBootstrap } from '@tsnomad/medusa-integration';
export const app = new MedusaBootstrap({ initializers: () => [new ReviewsInitializer()] });

// src/subscribers/review-created.ts
export default app.subscriber();
export const config = { event: 'review.created' };

// src/jobs/send-digest.ts
export default app.job(async (container) => (await container.get(DigestService)).send());
export const config = { name: 'send-digest', schedule: '0 * * * *' };

// src/api/admin/reviews/[id]/route.ts
export const GET = app.route();

// src/subscribers/tsnomad-tasks.ts, when an initializer has task handlers
export default app.tasks();
export const config = { event: app.taskEvents() };
```

The initializers bind Medusa actions to events, listen for events,
handle tasks and serve controllers, as any TS Nomad initializer does:

```ts
class ReviewsInitializer implements HasEventBindings, HasListeners, HasControllers {
  getEventBindings() {
    return [[ReviewPosted, { action: 'review.created', transformer: (data: { id: string }) => new ReviewPosted(data.id) }]];
  }
  getListeners() {
    return { [ReviewPosted.getId()]: NotifyModerators };
  }
  getControllers() {
    return [ShowReview]; // GET /admin/reviews/{id}
  }
}
```

## How each piece maps onto Medusa

**The boot.** Medusa module loaders cannot reach other modules or Query,
and every subscriber, job and route receives a container that can. So
the first of them to run boots TS Nomad, and every later call gets the
same container. Concurrent first calls share one boot. A failed boot is
logged once through Medusa's logger, with its stack, and is not kept:
the next call starts again with a new container. When a route runs
first, the container kept is that request's scope, so resolve only
application-wide registrations from `MedusaContainer`, such as modules,
`query` and `logger`.

**Actions.** Medusa loads subscriber files when it starts, before TS
Nomad boots, so `MedusaActionBindingStrategy` keeps the bindings, and
`app.subscriber()` hands each event to `runAction(event.name,
event.data, event)`. The subscriber file decides which events arrive.
Every binding of the action runs. Each failure is logged through
TS Nomad's logger with the action and event id, and the failures then
come back together in one `AggregateError`, which Medusa's event bus
logs too. An event with no binding is logged at error level, since the
subscriber file names an event nothing handles.

**Routes.** Medusa builds routes from files in `src/api`, so
`MedusaRestStrategy` keeps a route table, and `app.route()` hands each
request to it. The file decides which paths reach TS Nomad, and the
table picks the controller by method and endpoint, `{name}` marking a
path parameter. Fixed segments match in any case, as Express routes
them, and a HEAD request finds the GET controller, since Express hands
HEAD to a file's `GET` export. A path parameter cannot be replaced by a query or body
parameter of the same name, and a query or body key named `__proto__`
is dropped. A body that is not a plain object, such as a JSON list, adds
no parameters. A controller's `getBody()` is the raw
body when the route's middleware keeps it (`bodyParser: {
preserveRawBody: true }`), and an empty string otherwise.

The signed-in actor comes from `medusaActorOf(request)`, which returns
what Medusa's `authenticate` middleware put in `auth_context`, or null.
No header, query or body value changes it. It is also null for an
identity that has signed in but has no actor yet, which Medusa marks
with an empty `actor_id`. Medusa sets `auth_context` for a secret API
key on admin routes too, with the type `api-key` and the key's id, so
check the actor's type as well as its id. Put `authenticate` on the
route, then check, in the controller or its middleware, that the actor
may touch the record the path names:

```ts
async getResponse(request: Request): Promise<Response> {
  const actor = medusaActorOf(request);
  const id = String(request.getParam('id'));
  if (actor?.actorType !== 'user' || !(await this.reviews.ownedBy(id, actor.actorId))) {
    return this.responses.create().setStatus(404);
  }
  // ...
}
```

**Tasks.** `MedusaTaskStrategy` emits each task on Medusa's event bus,
as `tsnomad.task.<task id>`. The subscriber file built from `app.tasks()`
and `app.taskEvents()` hands each delivered event back to the strategy,
which runs the task's handlers. Medusa loads that file in every process,
so a worker that has run nothing else still boots and runs the task.
With the default local bus the task runs in the same process soon after
dispatch. With the Redis bus it runs in whichever process takes the
event.

Medusa drops an event that no subscriber listens to and says nothing.
So `dispatch` refuses a task whose event that subscriber file does not
serve: build the file with `app.tasks()` and give it `app.taskEvents()`
as its `config.event`, not a list written by hand.

Tasks are nudges, and the bus is not a durable queue. Neither bus
promises to keep an event through a restart. A task runs once per key
only when the application gives `MedusaTaskStrategy` an
`IdempotencyStore` through `useIdempotencyStore`. Without one, a task
dispatched twice runs twice, even one that names its work with
`idempotencyKey()`. Keep the state of the work
in your own tables, write every handler so a second run is harmless, and
let the domain that owns those tables settle work a lost task left
undone.

**Retries.** Neither bus tries a failed run again by default. The local
bus logs the failure and drops the event. The Redis bus runs it again
only when the application sets more than one attempt in the Redis
module's `jobOptions`, and that setting applies to every Medusa event,
not only to tasks. Each attempt writes the same error line, and after
the last one the event is gone.

A retried subscriber or task starts again from the first binding or
handler, so the ones that already succeeded run again. Every listener
and task handler must be safe to run more than once, as the TS Nomad
loader already asks. A listener that dispatches a task dispatches it
again on each attempt, so with N attempts a task can run as many as N
squared times.

Throw from a handler when a later run could succeed, such as after a
network error. When no later run could, such as for a record that no
longer exists, log the reason and return.

**Logging.** `MedusaLoggerStrategy` writes each line through Medusa's
logger, as `[<level>] <message>` plus the context as JSON. An Error in
the context keeps its `cause` and, for an `AggregateError`, its
`errors`. Error levels pass an `exception` Error on so Medusa prints its
stack. It never calls Medusa's `panic`. Every failure and wiring
mistake a strategy reports goes through the logger, and when the logger
itself throws, the strategy writes the line and both errors with
`console.error`, so nothing is lost. A task failure line carries the
task's payload, the only record of the work a dropped task carried.

**Jobs.** A job that throws is logged through TS Nomad's logger with its
stack, then rejects, since Medusa's job loader logs only the message.

## Medusa versions

`@medusajs/framework` is an optional peer dependency at `^2.0.0`, so
npm accepts any Medusa 2 release. The package is checked against 2.0
through 2.22.

The package imports nothing from Medusa at run time. It reads Medusa's
container by its registration names (`logger` and `event_bus`), which
have not changed since 2.0. A compile-only test holds its Medusa shapes
against `@medusajs/types` 2.22. The same shapes also typecheck against
the types of every 2.x minor release from 2.0 to 2.22, with the request
and response types taken from `@medusajs/framework/http` for the
releases before 2.22, whose `@medusajs/types` does not export them.

## Proof against a real Medusa

The tests here use a fake Medusa: a container, a logger and an event bus
that record what they get. They prove what each class does with what
Medusa hands it. A real Medusa 2.22 application, with the local and the
Redis event bus, is the proof that Medusa hands over what the fakes do.
That proof belongs to the package's end-to-end run.

## Where this differs from PHPNomad

- Every method that can wait returns a promise.
- The boot is lazy. A WordPress plugin boots from its main file on every
  request, and Medusa has no such moment that can reach Query.
- Actions and routes go through a table the strategy keeps, because
  Medusa registers subscribers and routes from files at start-up, where
  WordPress's `add_action` and `register_rest_route` work at run time.
- Events stay in the process. WordPress's event strategy broadcasts
  through `do_action('phpnomad/<id>')`, and this package uses TS Nomad's
  in-memory event strategy.
- `runAction` runs every binding and then rejects once, as TS Nomad's
  in-process event strategy does with listeners. A WordPress callback
  that throws stops the hook. It also logs each failure, and logs an
  action with no binding, where WordPress does neither.
- Path parameters win over body and query parameters. WordPress gives
  the body and query precedence.
- A request that a route file passes on, with no matching controller,
  gets a 404 and an error log line.
- There is no `HasRestNamespace` prefix, since the route file's folder
  is the path.
- A `{name}` segment matches any non-empty segment, decoded, as Medusa's
  `[name]` folders do. WordPress allows only letters, digits, `_` and
  `-`.
- When several routes match, the one with a fixed segment furthest to
  the left wins, as Medusa ranks its route files. WordPress takes the
  first route registered.
- `registerRoute` refuses an endpoint without a leading `/`, and a
  second route of one method whose endpoint differs only in parameter
  names or case. `register_rest_route` accepts both.
- A controller is resolved once, when its route is registered at boot.
  WordPress resolves it on each request's `rest_api_init`.
- `getParam` reads a name as one key. The WordPress request also reads a
  dotted name, such as `address.city`, as a path into nested values.
- The request has no current user. `medusaActorOf` returns the actor
  until TS Nomad has an auth package.
- `getBody()` is an empty string when Medusa kept no raw body. WordPress
  always has one.
- `MedusaTaskStrategy` takes its `IdempotencyStore` through
  `useIdempotencyStore` after the container is built, not in its
  constructor. Medusa's cache module cannot add a key only when it is
  absent, as WordPress's `wp_cache_add` does, so the application builds
  the store over its own database. Without one, a task dispatched twice
  runs twice.
- `MedusaTaskStrategy` signs nothing. WordPress signs the payload because
  Action Scheduler keeps it in a table other plugins can write.
- `MedusaTaskStrategy` keeps its handlers itself, with no separate
  registry.
- `dispatch` refuses a task with no handler in this process, or with no
  subscriber file to serve it, and checks the payload's trip through
  JSON, as TS Nomad's in-process task strategy does.
- A delivered event that is not a task, or has no handler here, is
  logged at error level. WordPress's `handleTask` returns without a word.
- A payload that `fromPayload` cannot rebuild is logged and dropped
  whatever it throws. WordPress catches only `TaskCreateFailedException`
  and lets anything else fail the run. A rebuild that failed once fails
  on every attempt.
- Failures are logged at the error level, as TS Nomad's in-process task
  strategy does.
- `MedusaLoggerStrategy` has no counterpart in the WordPress package.
- `MedusaInitializer` has no load condition, and it binds only what TS
  Nomad has packages for today. The Medusa version is checked when the
  package is installed, through its peer range, which npm enforces and
  some other package managers only warn about. The package itself calls
  nothing in Medusa that a version check would guard.

## Extracted 2026-11-17

This package moved into its own repository on 2026-11-17, at version
0.1.0, with its tests.

## License

Copyright (C) 2026 TSNomad.

This package is free software, released under the GNU General Public
License, version 3 or any later version (GPL-3.0-or-later). It comes
with no warranty. The full text is in [LICENSE](LICENSE).
