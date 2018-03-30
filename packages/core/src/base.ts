import { Breadcrumb, Context, SdkInfo, SentryEvent } from '@sentry/shim';
import { DSN } from './dsn';
import { Backend, Frontend, Options, Scope } from './interfaces';
import { SendStatus } from './status';

/**
 * Default maximum number of breadcrumbs added to an event. Can be overwritten
 * with {@link Options.maxBreadcrumbs}.
 */
const MAX_BREADCRUMBS = 100;

/** A class object that can instanciate Backend objects. */
export interface BackendClass<B extends Backend, O extends Options> {
  new (frontend: Frontend<O>): B;
}

/**
 * Base implementation for all JavaScript SDK frontends.
 *
 * Call the constructor with the corresponding backend constructor and options
 * specific to the frontend subclass. To access these options later, use
 * {@link Frontend.getOptions}. Also, the Backend instance is available via
 * {@link Frontend.getBackend}.
 *
 * Subclasses must implement one abstract method: {@link getSdkInfo}. It must
 * return the unique name and the version of the SDK.
 *
 * If a DSN is specified in the options, it will be parsed and stored. Use
 * {@link Frontend.getDSN} to retrieve the DSN at any moment. In case the DSN is
 * invalid, the constructor will throw a {@link SentryException}. Note that
 * without a valid DSN, the SDK will not send any events to Sentry.
 *
 * Before sending an event via the backend, it is passed through
 * {@link FrontendBase.prepareEvent} to add SDK information and scope data
 * (breadcrumbs and context). To add more custom information, override this
 * method and extend the resulting prepared event.
 *
 * To issue automatically created events (e.g. via instrumentation), use
 * {@link Frontend.captureEvent}. It will prepare the event and pass it through
 * the callback lifecycle. To issue auto-breadcrumbs, use
 * {@link Frontend.addBreadcrumb}.
 *
 * @example
 * class NodeFrontend extends FrontendBase<NodeBackend, NodeOptions> {
 *   public constructor(options: NodeOptions) {
 *     super(NodeBackend, options);
 *   }
 *
 *   // ...
 * }
 */
export abstract class FrontendBase<B extends Backend, O extends Options>
  implements Frontend<O> {
  /**
   * The backend used to physically interact in the enviornment. Usually, this
   * will correspond to the frontend. When composing SDKs, however, the Backend
   * from the root SDK will be used.
   */
  private readonly backend: B;

  /** Options passed to the SDK. */
  private readonly options: O;

  /**
   * The client DSN, if specified in options. Without this DSN, the SDK will be
   * disabled.
   */
  private readonly dsn?: DSN;

  /**
   * A scope instance containing breadcrumbs and context, used if none is
   * specified to the public methods. This is specifically used in standalone
   * mode, when the Frontend is directly instanciated by the user.
   */
  private readonly internalScope: Scope;

  /**
   * Stores whether installation has been performed and was successful. Before
   * installing, this is undefined. Then it contains the success state.
   */
  private installed?: boolean;

  /**
   * Initializes this frontend instance.
   *
   * @param backendClass A constructor function to create the backend.
   * @param options Options for the frontend.
   */
  protected constructor(backendClass: BackendClass<B, O>, options: O) {
    this.backend = new backendClass(this);
    this.options = options;

    if (options.dsn) {
      this.dsn = new DSN(options.dsn);
    }

    // The initial scope must have access to backend, options and DSN
    this.internalScope = this.getInitialScope();
  }

  /**
   * @inheritDoc
   */
  public install(): boolean {
    if (!this.isEnabled()) {
      return false;
    }

    if (this.installed === undefined) {
      this.installed = this.getBackend().install();
    }

    return this.installed;
  }

  /**
   * @inheritDoc
   */
  public async captureException(
    exception: any,
    scope: Scope = this.internalScope,
  ): Promise<void> {
    const event = await this.getBackend().eventFromException(exception);
    await this.captureEvent(event, scope);
  }

  /**
   * @inheritDoc
   */
  public async captureMessage(
    message: string,
    scope: Scope = this.internalScope,
  ): Promise<void> {
    const event = await this.getBackend().eventFromMessage(message);
    await this.captureEvent(event, scope);
  }

  /**
   * @inheritDoc
   */
  public async captureEvent(
    event: SentryEvent,
    scope: Scope = this.internalScope,
  ): Promise<void> {
    await this.sendEvent(event, scope);
  }

  /**
   * @inheritDoc
   */
  public async addBreadcrumb(
    breadcrumb: Breadcrumb,
    scope: Scope = this.internalScope,
  ): Promise<void> {
    const {
      shouldAddBreadcrumb,
      beforeBreadcrumb,
      afterBreadcrumb,
      maxBreadcrumbs = MAX_BREADCRUMBS,
    } = this.getOptions();

    if (maxBreadcrumbs === 0) {
      return;
    }

    const timestamp = new Date().getTime() / 1000;
    const mergedBreadcrumb = { timestamp, ...breadcrumb };
    if (shouldAddBreadcrumb && !shouldAddBreadcrumb(mergedBreadcrumb)) {
      return;
    }

    const finalBreadcrumb = beforeBreadcrumb
      ? beforeBreadcrumb(mergedBreadcrumb)
      : mergedBreadcrumb;

    if (await this.getBackend().storeBreadcrumb(finalBreadcrumb, scope)) {
      scope.breadcrumbs = [...scope.breadcrumbs, finalBreadcrumb].slice(
        -maxBreadcrumbs,
      );
    }

    if (afterBreadcrumb) {
      afterBreadcrumb(finalBreadcrumb);
    }
  }

  /**
   * @inheritDoc
   */
  public getDSN(): DSN | undefined {
    return this.dsn;
  }

  /**
   * @inheritDoc
   */
  public getOptions(): O {
    return this.options;
  }

  /**
   * @inheritDoc
   */
  public async setContext(
    nextContext: Context,
    scope: Scope = this.internalScope,
  ): Promise<void> {
    if (await this.getBackend().storeContext(nextContext, scope)) {
      const context = scope.context;
      if (nextContext.extra) {
        context.extra = { ...context.extra, ...nextContext.extra };
      }
      if (nextContext.tags) {
        context.tags = { ...context.tags, ...nextContext.tags };
      }
      if (nextContext.user) {
        context.user = { ...context.user, ...nextContext.user };
      }
    }
  }

  /**
   * @inheritDoc
   */
  public getInitialScope(): Scope {
    return {
      breadcrumbs: [],
      context: {},
    };
  }

  /** Returns the current used SDK version and name. */
  protected abstract getSdkInfo(): SdkInfo;

  /** Returns the current internal scope of this instance. */
  protected getInternalScope(): Scope {
    return this.internalScope;
  }

  /** Returns the current backend. */
  protected getBackend(): B {
    return this.backend;
  }

  /** Determines whether this SDK is enabled and a valid DSN is present. */
  protected isEnabled(): boolean {
    return this.getOptions().enabled !== false && this.dsn !== undefined;
  }

  /**
   * Adds common information to events.
   *
   * The information includes release and environment from `options`, SDK
   * information returned by {@link FrontendBase.getSdkInfo}, as well as
   * breadcrumbs and context (extra, tags and user) from the scope.
   *
   * Information that is already present in the event is never overwritten. For
   * nested objects, such as the context, keys are merged.
   *
   * @param event The original event.
   * @param scope A scope containing event metadata.
   * @returns A new event with more information.
   */
  protected async prepareEvent(
    event: SentryEvent,
    scope: Scope,
  ): Promise<SentryEvent> {
    const {
      environment,
      maxBreadcrumbs = MAX_BREADCRUMBS,
      release,
    } = this.getOptions();

    const prepared = { sdk: this.getSdkInfo(), ...event };
    if (prepared.environment === undefined && environment !== undefined) {
      prepared.environment = environment;
    }
    if (prepared.release === undefined && release !== undefined) {
      prepared.release = release;
    }

    const breadcrumbs = scope.breadcrumbs;
    if (breadcrumbs.length > 0 && maxBreadcrumbs > 0) {
      prepared.breadcrumbs = breadcrumbs.slice(-maxBreadcrumbs);
    }

    const context = scope.context;
    if (context.extra) {
      prepared.extra = { ...context.extra, ...event.extra };
    }
    if (context.tags) {
      prepared.tags = { ...context.tags, ...event.tags };
    }
    if (context.user) {
      prepared.user = { ...context.user, ...event.user };
    }

    return prepared;
  }

  /**
   * Sends an event (either error or message) to Sentry.
   *
   * This also adds breadcrumbs and context information to the event. However,
   * platform specific meta data (such as the User's IP address) must be added
   * by the SDK implementor.
   *
   * The returned event status offers clues to whether the event was sent to
   * Sentry and accepted there. If the {@link Options.shouldSend} hook returns
   * `false`, the status will be {@link SendStatus.Skipped}. If the rate limit
   * was exceeded, the status will be {@link SendStatus.RateLimit}.
   *
   * @param event The event to send to Sentry.
   * @param scope A scope containing event metadata.
   * @returns A Promise that resolves with the event status.
   */
  private async sendEvent(
    event: SentryEvent,
    scope: Scope,
  ): Promise<SendStatus> {
    if (!this.isEnabled()) {
      return SendStatus.Skipped;
    }

    const prepared = await this.prepareEvent(event, scope);
    const { shouldSend, beforeSend, afterSend } = this.getOptions();
    if (shouldSend && !shouldSend(prepared)) {
      return SendStatus.Skipped;
    }

    const finalEvent = beforeSend ? beforeSend(prepared) : prepared;
    const code = await this.getBackend().sendEvent(finalEvent);
    const status = SendStatus.fromHttpCode(code);

    if (status === SendStatus.RateLimit) {
      // TODO: Handle rate limits and maintain a queue. For now, we require SDK
      // implementors to override this method and handle it themselves.
    }

    if (afterSend) {
      afterSend(finalEvent, status);
    }

    return status;
  }
}
