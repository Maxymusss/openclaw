import OpenClawChatUI
import OpenClawKit
import SwiftUI
import UIKit

struct RootTabs: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(NativeActionRouter.self) private var nativeActions: NativeActionRouter?
    #if DEBUG && OPENCLAW_INSTALLED_NATIVE_ACTION_PROOF
    @Environment(InstalledNativeActionProofHost.self) private var installedNativeProof: InstalledNativeActionProofHost?
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @AppStorage("onboarding.requestID") private var onboardingRequestID: Int = 0
    @AppStorage("gateway.onboardingComplete") private var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") private var hasConnectedOnce: Bool = false
    @AppStorage("gateway.preferredStableID") private var preferredGatewayStableID: String = ""
    @AppStorage("gateway.manual.enabled") private var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") private var manualGatewayHost: String = ""
    @AppStorage("onboarding.quickSetupDismissed") private var quickSetupDismissed: Bool = false
    @State private var selectedSidebarDestination: SidebarDestination = Self.initialSidebarDestination
    @State private var selectedSettingsRoute: SettingsRoute? =
        Self.initialSidebarDestination.settingsRoute
    @State private var activeSettingsRoute: SettingsRoute? =
        Self.initialSidebarDestination.settingsRoute
    @State private var selectedSettingsRouteRequestID: Int = 0
    @State private var sidebarModel = RootSidebarModel()
    // Embedded Settings rows push onto the sidebar stack; clear it before
    // changing sidebar roots so stale settings detail screens cannot survive.
    @State private var sidebarNavigationPath: [SettingsRoute] = []
    @State private var isSidebarDetailRootVisible: Bool = true
    @State private var isSidebarVisible: Bool = Self.initialSidebarVisibility ?? false
    @State private var sidebarVisibilityUserOverridden: Bool = Self.initialSidebarVisibility != nil
    @State private var isSidebarDrawerLayout: Bool = false
    @State private var didResolveSidebarLayout: Bool = false
    @State private var voiceWakeToastText: String?
    @State private var toastDismissGate = DelayedActionGate()
    @State private var presentedSheet: PresentedSheet?
    @State private var pagesEditor: SidebarPagesPresentation?
    @State private var showGatewayProblemDetails: Bool = false
    @State private var gatewayToastDragOffset: CGFloat = 0
    @State private var gatewayRetryFailure: String?
    // Swipe-up hides the toast only until the next problem report.
    @State private var isGatewayToastSwipeDismissed: Bool = false
    @State private var showOnboarding: Bool = false
    @State private var onboardingAllowSkip: Bool = true
    @State private var didEvaluateOnboarding: Bool = false
    @State private var didAutoOpenSettings: Bool = false
    @State private var didApplyInitialChatSession: Bool = false
    @State private var gatewaySetupRequest: GatewaySetupRequest?
    @State private var suppressedExecApprovalForNotificationSettings: NodeAppModel.ExecApprovalInboxKey?
    @State private var nativeRunInspection: NativeActionRouter.RunPresentation?
    @State private var nativeChatBinding: IOSNativeActionBinding?
    @State private var nativePresentationID: UUID?
    @State private var nativeLifetime = IOSNativePresentationLifetime()
    @State private var chatModals = OpenClawChatModalPresentations()
    @State private var chatModalScope: ChatModalScope?
    @State private var transcriptExportError: OpenClawChatModalPresentations.Receipt?

    private struct ChatModalScope: Equatable {
        let origin: OpenClawChatModalOrigin
        let shellID: String
        let ownerID: String
        let sessionKey: String
        let agentID: String?
        let accountGeneration: UInt64
        let inputs: GatewayConnectConfig.ControlUIInputs?
    }

    init(initialSidebarVisibility: Bool? = nil) {
        let resolvedVisibility = initialSidebarVisibility ?? Self.initialSidebarVisibility
        _isSidebarVisible = State(initialValue: resolvedVisibility ?? false)
        _sidebarVisibilityUserOverridden = State(initialValue: resolvedVisibility != nil)
    }

    private static var initialSidebarDestination: SidebarDestination {
        initialDestination(arguments: ProcessInfo.processInfo.arguments)
    }

    private static var initialSidebarVisibility: Bool? {
        requestedInitialSidebarVisibility(arguments: ProcessInfo.processInfo.arguments)
    }

    private static var initialChatSessionKey: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-chat-session") else {
            return nil
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return nil }
        let trimmed = arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var chatPresentation: IOSChatViewModelOwner.Presentation {
        .init(binding: self.nativeChatBinding, router: self.nativeActions, id: self.nativePresentationID)
    }

    var body: some View {
        let newChat = self.appModel.chatPresentation.currentNewChatRequest(
            appModel: self.appModel,
            presentation: self.chatPresentation)
        return self.rootPresentation(
            self.rootLifecycle(
                self.rootOverlays(
                    self.sidebarSplitContent
                        .tint(OpenClawBrand.accent))))
            .environment(\.userNavigationAction, navigationAction())
            .background(IOSNativePresentationAnchor(lifetime: self.nativeLifetime).frame(width: 0, height: 0))
            .onChange(of: self.currentChatModalScope, initial: true) { _, _ in
                self.synchronizeChatModalScope()
            }
            .overlay(alignment: .topLeading) {
                self.uiTestReadinessMarker
                #if DEBUG && OPENCLAW_INSTALLED_NATIVE_ACTION_PROOF
                if let installedNativeProof {
                    Color.clear.frame(width: 1, height: 1)
                        .allowsHitTesting(false)
                        .accessibilityElement(children: .ignore)
                        .accessibilityIdentifier("RootTabs.InstalledNativeProof")
                        .accessibilityLabel(Text(verbatim: "Installed native action observation"))
                        .accessibilityValue(installedNativeProof.accessibilityValue(
                            idleUnprotectedComposer: self.appModel.chatPresentation
                                .isCurrent(appModel: self.appModel) &&
                                self.appModel.chatPresentation.viewModel?.canPreserveIdleTextDraft == true &&
                                !self.appModel.chatPresentation.hasProtectedComposer(appModel: self.appModel)))
                }
                #endif
            }
            .task(id: self.appModel.chatPresentation.taskIdentity(
                appModel: self.appModel,
                nativeBinding: self.nativeChatBinding,
                presentationID: self.nativePresentationID,
                chatRegistrationID: self.nativeActions?.chatRegistrationID))
            {
                await self.appModel.chatPresentation.synchronizePresentation(
                    appModel: self.appModel,
                    currentPresentation: { self.chatPresentation })
            }
            .task(id: newChat.map(ObjectIdentifier.init)) {
                    guard let newChat else { return }
                    await self.appModel.chatPresentation.performNewChat(
                        newChat,
                        appModel: self.appModel,
                        currentPresentation: { self.chatPresentation })
                }
    }

    @ViewBuilder
    private var uiTestReadinessMarker: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--openclaw-ui-test-readiness") {
            Color.clear
                .frame(width: 1, height: 1)
                .allowsHitTesting(false)
                .accessibilityElement(children: .ignore)
                .accessibilityIdentifier("RootTabs.Ready")
                .accessibilityLabel(Text(verbatim: "OpenClaw test readiness"))
                .accessibilityValue(
                    "\(self.scenePhase == .active ? "ready" : "inactive"):\(self.selectedSidebarDestination.rawValue)")
        }
        #endif
    }

    private var sidebarSplitContent: some View {
        GeometryReader { proxy in
            // Keyboard safe-area changes must not masquerade as window/orientation changes;
            // switching layouts destroys the focused detail subtree.
            let layoutContainerSize = Self.sidebarLayoutContainerSize(
                contentSize: proxy.size,
                windowSize: self.foregroundKeyWindowSize())
            let isDrawerLayout = self.shouldUseSidebarDrawer(containerSize: layoutContainerSize)
            let sidebarWidth = self.sidebarWidth(
                containerWidth: layoutContainerSize.width,
                isDrawerLayout: isDrawerLayout)
            Group {
                if isDrawerLayout {
                    self.sidebarDrawerContent(
                        sidebarWidth: sidebarWidth,
                        safeAreaInsets: proxy.safeAreaInsets)
                } else {
                    self.sidebarNavigationSplitContent(sidebarWidth: sidebarWidth)
                }
            }
            .onAppear {
                self.updateSidebarLayout(containerSize: layoutContainerSize, force: false)
            }
            .onChange(of: proxy.size) { _, size in
                let layoutContainerSize = Self.sidebarLayoutContainerSize(
                    contentSize: size,
                    windowSize: self.foregroundKeyWindowSize())
                self.updateSidebarLayout(containerSize: layoutContainerSize, force: false)
            }
            // Single refresh owner: identity/session changes, scene activation,
            // and the periodic attention refresh all land here.
            .task(id: self.sidebarRefreshID) {
                guard self.scenePhase == .active else { return }
                await self.sidebarModel.refresh(appModel: self.appModel)
                await self.appModel.refreshPendingApprovalInbox()
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(600))
                    guard !Task.isCancelled else { return }
                    await self.sidebarModel.refresh(appModel: self.appModel)
                    await self.appModel.refreshPendingApprovalInbox()
                }
            }
            .task(id: "\(self.sidebarRefreshID):events") {
                guard self.scenePhase == .active else { return }
                await self.sidebarModel.observeSessionEvents(appModel: self.appModel)
            }
            .task(id: self.sessionObserverTaskIdentity) {
                await self.sidebarModel.setSessionObserverVisibility(
                    appModel: self.appModel,
                    visible: self.sessionObserverTaskIdentity.isObserverVisible)
            }
        }
    }

    private var sessionObserverTaskIdentity: SessionObserverTaskIdentity {
        SessionObserverTaskIdentity(
            sidebarRefreshID: self.sidebarRefreshID,
            isSceneActive: self.scenePhase == .active,
            isSidebarVisible: self.isSidebarVisible)
    }

    private var sidebarRefreshID: String {
        [
            self.appModel.chatViewModelIdentityID,
            self.appModel.chatSessionKey,
            String(self.appModel.operatorAuthorityGeneration),
            self.scenePhase == .active ? "active" : "inactive",
        ].joined(separator: ":")
    }

    private func sidebarNavigationSplitContent(sidebarWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            if self.isSidebarVisible {
                self.sidebarColumn()
                    .frame(width: sidebarWidth, alignment: .topLeading)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    .overlay(alignment: .trailing) {
                        self.sidebarVerticalSeparator
                    }
                    .transition(self.sidebarTransition)
            }

            self.sidebarDetailNavigationShell
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(OpenClawProBackground())
        .animation(self.sidebarAnimation, value: self.isSidebarVisible)
    }

    private func sidebarDrawerContent(
        sidebarWidth: CGFloat,
        safeAreaInsets: EdgeInsets) -> some View
    {
        RootSidebarDrawer(
            sidebarWidth: sidebarWidth,
            isPresented: self.isSidebarVisible,
            canOpenFromEdge: self.isSidebarDetailRootVisible && self.sidebarNavigationPath.isEmpty,
            reduceMotion: self.reduceMotion,
            animation: self.sidebarAnimation,
            onShow: self.showSidebar,
            onHide: self.hideSidebar,
            sidebar: self.sidebarColumn(drawerSafeAreaInsets: safeAreaInsets),
            detail: self.sidebarDetailNavigationShell)
    }

    private var sidebarDetailShell: some View {
        let shellID = self.sidebarDetailShellID
        return self.sidebarDetail
            .environment(\.userNavigationAction, navigationAction(detail: true))
            .id(shellID)
            // Destination-style links replace this root inside the shared stack;
            // the Settings hub owns its stack and reports typed pushes through the path.
            .onAppear {
                guard self.sidebarDetailShellID == shellID else { return }
                self.isSidebarDetailRootVisible = true
            }
            .onDisappear {
                guard self.sidebarDetailShellID == shellID else { return }
                self.isSidebarDetailRootVisible = false
            }
    }

    /// RootSidebar owns its dark surface; this wrapper only restores vertical
    /// insets. Drawer mode goes full-bleed (ignoresSafeArea) so the captured
    /// insets are re-applied manually; split mode keeps system safe areas.
    private func sidebarColumn(drawerSafeAreaInsets: EdgeInsets? = nil) -> some View {
        let action = navigationAction()
        return RootSidebar(
            model: self.sidebarModel,
            pagesEditor: self.userModalBinding(self.$pagesEditor),
            selectedDestination: self.selectedSidebarDestination,
            isDrawerLayout: self.isSidebarDrawerLayout,
            isDismissButtonEnabled: self.isSidebarVisible,
            isPagesEditorRootCurrent: self.navigationContext(),
            selectDestination: { destination in
                guard action() else { return }
                self.selectSidebarDestination(destination)
            },
            selectSession: { session in
                guard action() else { return }
                self.selectSidebarSession(session)
            },
            openChat: openChatAction(),
            requestNewChat: userAction(disposition: .chatSessionTransition) {
                self.appModel.chatPresentation.requestNewChat(
                    appModel: self.appModel,
                    presentation: self.chatPresentation)
                self.selectSidebarDestination(.chat)
            },
            prepareFork: prepareForkAction(),
            hideSidebar: hideSidebar)
            .padding(.top, drawerSafeAreaInsets.map { $0.top + 8 } ?? 0)
            .padding(.bottom, drawerSafeAreaInsets.map { $0.bottom + 8 } ?? 0)
            .safeAreaPadding(.top, drawerSafeAreaInsets == nil ? 8 : 0)
            .safeAreaPadding(.bottom, drawerSafeAreaInsets == nil ? 8 : 0)
            // Paints the wrapper's inset strips; RootSidebar's own background
            // stops at its bounds.
            .background(OpenClawSidebarPalette.background)
    }

    private var sidebarVerticalSeparator: some View {
        Rectangle()
            .fill(OpenClawSidebarPalette.hairline)
            .frame(width: 1 / self.displayScale)
    }

    @ViewBuilder
    private var sidebarDetail: some View {
        switch self.selectedSidebarDestination.screen {
        case .chat:
            // Agent identity pill owns the chat header (prototype parity).
            ChatProTab(
                headerSidebarAction: self.sidebarHeaderAction,
                nativeBinding: self.nativeChatBinding,
                nativePresentationID: self.nativePresentationID,
                openSettings: userDestinationAction(.gateway),
                prepareModal: self.prepareChatModal,
                retainModalPresentation: self.retainChatModalPresentation)
                .openClawChatModalPresentations(
                    self.chatModals,
                    origin: self.currentChatModalScope?.origin ?? self.chatModals.standaloneOrigin,
                    actions: self.chatModalActions)
        case .overview:
            CommandCenterTab(
                headerTitle: "Overview",
                headerSidebarAction: self.sidebarHeaderAction,
                dashboardModel: self.sidebarModel,
                openChat: openChatAction(detail: true),
                prepareFork: prepareForkAction(detail: true),
                openSettings: userDestinationAction(.gateway),
                openSessions: userDestinationAction(.sessions),
                openApprovals: userAction(detail: true) { self.selectSettingsRoute(.approvals) },
                openAutomations: userDestinationAction(.cron),
                openUsage: userDestinationAction(.usage))
        case let .dashboard(path):
            DashboardPageScreen(
                path: path,
                title: self.selectedSidebarDestination.title,
                headerSidebarAction: self.sidebarHeaderAction,
                onRouteChange: handleSettingsRouteChange,
                onApprovalNotificationsRoute: notificationSettingsAction(detail: true))
                .id(path)
        case .agents:
            AgentProTab(
                directRoute: .agents,
                headerSidebarAction: self.sidebarHeaderAction,
                headerTitle: "Agents",
                openSettings: userDestinationAction(.gateway))
                .id(self.selectedSidebarDestination.id)
        case .sessions:
            CommandSessionsScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                openChat: openChatAction(detail: true),
                prepareFork: prepareForkAction(detail: true))
        case .files:
            AgentProTab(
                directRoute: .files,
                headerSidebarAction: self.sidebarHeaderAction,
                headerTitle: "Files",
                openSettings: userDestinationAction(.gateway))
                .id(self.selectedSidebarDestination.id)
        case .desktop:
            DesktopHubScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                gatewayAction: userDestinationAction(.gateway))
        case .terminal:
            TerminalHubScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                gatewayAction: userDestinationAction(.gateway))
        case .docs:
            OpenClawDocsScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                gatewayAction: userDestinationAction(.gateway))
        case .settings:
            SettingsHubScreen(
                navigationPath: userSettingsPath,
                headerSidebarAction: self.sidebarHeaderAction,
                onRouteChange: handleSettingsRouteChange,
                onApprovalNotificationsRoute: notificationSettingsAction(detail: true))
        case .gateway:
            SettingsProTab(
                directRoute: self.selectedSettingsRoute ?? self.selectedSidebarDestination.settingsRoute ?? .gateway,
                acceptsGatewaySetupRequests: !self.showOnboarding,
                headerSidebarAction: self.sidebarHeaderAction,
                onRouteChange: handleSettingsRouteChange,
                onApprovalNotificationsRoute: notificationSettingsAction(detail: true),
                gatewaySetupRequest: self.gatewaySetupRequest,
                onGatewaySetupRequestHandled: handleGatewaySetupRequest)
        }
    }

    private var sidebarDetailNavigationShell: some View {
        Group {
            if self.selectedSidebarDestination == .settings {
                self.sidebarDetailShell
            } else if case .dashboard = self.selectedSidebarDestination.screen {
                self.sidebarDetailShell
            } else {
                NavigationStack(path: self.userSettingsPath) {
                    self.sidebarDetailShell
                }
            }
        }
        .onChange(of: self.sidebarNavigationPath) { _, navigationPath in
            self.handleSidebarSettingsNavigationPathChange(navigationPath)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var sidebarDetailShellID: String {
        let routeID = self.selectedSettingsRoute.map { "\($0)" } ?? "root"
        return "\(self.selectedSidebarDestination.id):\(routeID):\(self.selectedSettingsRouteRequestID)"
    }

    private var activeExecApprovalPromptSuppression: NodeAppModel.ExecApprovalInboxKey? {
        if case .notificationSettings = self.presentedSheet {
            return self.suppressedExecApprovalForNotificationSettings
        }
        guard self.activeSettingsRoute == .approvals else { return nil }
        return NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt)
    }

    private var shouldCollapseSidebarAfterSelection: Bool {
        Self.shouldCollapseSidebarAfterSelection(
            layoutMode: self.isSidebarDrawerLayout ? .drawer : .split)
    }

    private var sidebarHeaderAction: OpenClawSidebarHeaderAction? {
        guard Self.shouldShowSidebarRevealInDestinationHeader(
            isSidebarVisible: self.isSidebarVisible,
            layoutMode: self.isSidebarDrawerLayout ? .drawer : .split)
        else {
            return nil
        }
        if self.isSidebarVisible {
            return OpenClawSidebarHeaderAction(
                systemName: "line.3.horizontal",
                accessibilityLabel: .localized("Hide Sidebar"),
                accessibilityIdentifier: Self.sidebarHideButtonAccessibilityIdentifier,
                action: { self.hideSidebar() })
        }
        return OpenClawSidebarHeaderAction(
            systemName: "line.3.horizontal",
            accessibilityLabel: .localized("Show Sidebar"),
            accessibilityIdentifier: Self.sidebarShowButtonAccessibilityIdentifier,
            action: { self.showSidebar() })
    }

    private var sidebarAnimation: Animation? {
        self.reduceMotion ? .easeOut(duration: 0.16) : .spring(response: 0.35, dampingFraction: 0.86)
    }

    private var sidebarTransition: AnyTransition {
        self.reduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity)
    }

    private func shouldUseSidebarDrawer(containerSize: CGSize) -> Bool {
        Self.sidebarLayoutMode(containerSize: containerSize) == .drawer
    }

    private func sidebarWidth(containerWidth: CGFloat, isDrawerLayout: Bool) -> CGFloat {
        Self.sidebarWidth(containerWidth: containerWidth, isDrawerLayout: isDrawerLayout)
    }

    private func foregroundKeyWindowSize() -> CGSize? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })?
            .windows
            .first(where: \.isKeyWindow)?
            .bounds.size
    }

    private func rootOverlays(_ content: some View) -> some View {
        content
            .overlay(alignment: .top) {
                // Stable container so the toast's move/opacity transition animates
                // when the gateway problem appears or clears outside withAnimation.
                ZStack(alignment: .top) {
                    if let liveVoiceStartError = self.appModel.liveVoiceStartError {
                        // A banner survives onboarding dismissal without racing another modal.
                        OpenClawNoticeBanner(
                            icon: "mic.slash",
                            title: "Unable to Start Live Voice",
                            message: .verbatim(liveVoiceStartError),
                            ownerLabel: "Needs attention",
                            tint: OpenClawBrand.warn,
                            secondaryActionTitle: "Dismiss",
                            onSecondaryAction: { self.appModel.liveVoiceStartError = nil })
                            .padding(.horizontal, 12)
                            .safeAreaPadding(.top, 10)
                    } else if let gatewayRetryFailure {
                        OpenClawNoticeBanner(
                            icon: "wifi.exclamationmark",
                            title: "Gateway reconnect failed",
                            message: .verbatim(gatewayRetryFailure),
                            ownerLabel: "Needs attention",
                            tint: OpenClawBrand.warn,
                            secondaryActionTitle: "Dismiss",
                            onSecondaryAction: { self.gatewayRetryFailure = nil })
                            .padding(.horizontal, 12)
                            .safeAreaPadding(.top, 10)
                            .transition(.move(edge: .top).combined(with: .opacity))
                    } else if let gatewayProblem = self.activeGatewayProblemToast {
                        self.gatewayProblemToast(gatewayProblem)
                    }
                }
                .animation(self.gatewayToastAnimation, value: self.gatewayRetryFailure)
                .animation(self.gatewayToastAnimation, value: self.activeGatewayProblemToast)
            }
            .overlay(alignment: .topLeading) {
                if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                    VoiceWakeToast(command: voiceWakeToastText)
                        .padding(.leading, 10)
                        .safeAreaPadding(
                            .top,
                            self.activeGatewayProblemToast == nil && self.gatewayRetryFailure == nil
                                && self.appModel.liveVoiceStartError == nil ? 58 : 132)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }

            .overlay {
                // Keep the observer mounted so the first 0 -> 1 capture transition
                // flashes without treating a later remount as a new capture.
                RootCameraFlashOverlay(nonce: self.appModel.cameraFlashNonce)
            }
    }

    private var activeGatewayProblemToast: GatewayConnectionProblem? {
        // Operator-scope auth/pairing failures can coexist with a connected node.
        // The problem itself, not aggregate gateway status, owns toast visibility.
        guard let problem = appModel.lastGatewayProblem,
              !self.isGatewayToastSwipeDismissed
        else { return nil }
        return problem
    }

    private var gatewayToastAnimation: Animation? {
        self.reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85)
    }

    private func gatewayProblemToast(_ problem: GatewayConnectionProblem) -> some View {
        let action = navigationAction()
        return GatewayProblemBanner(
            problem: problem,
            primaryActionTitle: gatewayProblemPrimaryActionTitle(problem),
            onPrimaryAction: {
                self.handleGatewayProblemPrimaryAction(problem, onNavigate: action)
            },
            onShowDetails: {
                guard action() else { return }
                self.showGatewayProblemDetails = true
            })
            .padding(.horizontal, 12)
            .safeAreaPadding(.top, 10)
            .offset(y: min(self.gatewayToastDragOffset, 0))
            .gesture(self.gatewayToastSwipeGesture)
            // A drag cancelled by toast removal never fires onEnded; clear the
            // offset so the next toast doesn't render shifted up.
            .onDisappear { self.gatewayToastDragOffset = 0 }
            .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var gatewayToastSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                self.gatewayToastDragOffset = value.translation.height
            }
            .onEnded { value in
                let swipedUp = value.translation.height < -32 || value.predictedEndTranslation.height < -80
                withAnimation(self.gatewayToastAnimation) {
                    if swipedUp {
                        self.isGatewayToastSwipeDismissed = true
                    }
                    self.gatewayToastDragOffset = 0
                }
            }
    }

    private func handleGatewayProblemReport() {
        guard self.isGatewayToastSwipeDismissed else { return }
        self.isGatewayToastSwipeDismissed = false
    }

    private func rootLifecycle(_ content: some View) -> some View {
        self.rootRequestLifecycle(
            self.rootGatewayLifecycle(
                self.rootAppearLifecycle(
                    self.rootVoiceWakeLifecycle(content))))
    }

    private func rootVoiceWakeLifecycle(_ content: some View) -> some View {
        content
            .onChange(of: self.voiceWake.lastTriggeredCommand) { _, newValue in
                guard let newValue else { return }
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }

                withAnimation(self.reduceMotion ? .none : .spring(response: 0.25, dampingFraction: 0.85)) {
                    self.voiceWakeToastText = trimmed
                }

                self.toastDismissGate.schedule(after: .milliseconds(2300)) {
                    withAnimation(self.reduceMotion ? .none : .easeOut(duration: 0.25)) {
                        self.voiceWakeToastText = nil
                    }
                }
            }
    }

    private func rootAppearLifecycle(_ content: some View) -> some View {
        let inspections = self.userModalBinding(self.$nativeRunInspection)
        return content
            .onAppear {
                self.updateIdleTimer()
                self.evaluateOnboardingPresentation(force: false)
                self.maybeAutoOpenSettings()
                self.maybeOpenSettingsForGatewaySetup()
                self.maybeShowQuickSetup()
                self.applyInitialChatSessionIfNeeded()
                self.handleLiveVoiceStartRequest()
                if self.appModel.consumeOpenChatRequest(self.appModel.openChatRequestID) {
                    self.selectSidebarDestination(.chat)
                }
                if self.appModel.consumeDashboardNavigationRequest(self.appModel.dashboardNavigationRequestID) {
                    self.selectSidebarDestination(.overview)
                }
                if self.nativeActions?.capturePresentationAuthority(self.nativePresentationID) != nil { return }
                self.nativePresentationID = self.nativeActions?.registerPresentation(onRetire: { disposition in
                    // Modal interactions and in-place session creation retire old
                    // native operations while retaining their current UI transport.
                    if case .departure = disposition { self.nativeChatBinding = nil }
                    self.nativeRunInspection = nil
                }, onSessionAdopted: { previous, binding in
                    guard self.nativeChatBinding == nil ||
                        self.nativeChatBinding?.canReuse(previous) == true else { return }
                    self.nativeChatBinding = binding
                }, { request, binding, receipt in
                    self.synchronizeChatModalScope()
                    guard !self.chatModals.hasActivePresentation, self.transcriptExportError == nil,
                          UIApplication.shared.applicationState == .active,
                          !self.showOnboarding, !self.showGatewayProblemDetails, self.presentedSheet == nil,
                          self.pagesEditor == nil,
                          self.appModel.pendingExecApprovalPrompt == nil,
                          self.appModel.pendingNotificationPermissionGuidancePrompt == nil,
                          self.appModel.pendingAgentDeepLinkPrompt == nil,
                          self.gatewayController.pendingTrustPrompt == nil
                    else {
                        throw OpenClawNativeActionError("Finish the current screen in OpenClaw, then try again.")
                    }
                    if let existing = self.nativeRunInspection {
                        guard case let .inspect(run) = request, existing.inspection.run == run else {
                            throw OpenClawNativeActionError("Close the current run inspection, then try again.")
                        }
                    }
                    let session = request.session
                    self.appModel.setSelectedAgentId(session.agentID)
                    self.appModel.focusChatSession(session.sessionKey)
                    self.nativeChatBinding = binding
                    self.selectSidebarDestination(.chat)
                    self.nativeRunInspection = receipt
                })
                if let id = self.nativePresentationID {
                    self.nativeLifetime.own(id) {
                        self.nativeActions?.unregisterPresentation(id)
                        guard self.nativePresentationID == id else { return }
                        self.nativePresentationID = nil
                        self.pagesEditor = nil
                        self.clearChatModalScope()
                    }
                }
            }
            .sheet(item: inspections) { presentation in
                NavigationStack {
                    Form {
                        LabeledContent {
                            Text(presentation.inspection.run.runID).font(OpenClawType.body)
                        } label: {
                            Text("Run").font(OpenClawType.body)
                        }
                        LabeledContent {
                            Text(presentation.inspection.run.session.sessionKey).font(OpenClawType.body)
                        } label: {
                            Text("Session").font(OpenClawType.body)
                        }
                        LabeledContent {
                            Text(presentation.inspection.run.session.agentID).font(OpenClawType.body)
                        } label: {
                            Text("Agent").font(OpenClawType.body)
                        }
                        LabeledContent {
                            Text(presentation.inspection.run.session.owner.profileID).font(OpenClawType.body)
                        } label: {
                            Text("Account").font(OpenClawType.body)
                        }
                        LabeledContent {
                            Text(presentation.inspection.run.session.owner.gatewayID).font(OpenClawType.body)
                        } label: {
                            Text("Gateway").font(OpenClawType.body)
                        }
                        Text(presentation.inspection.summary)
                            .font(OpenClawType.body)
                            .textSelection(.enabled)
                    }
                    .navigationTitle("Run")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button {
                                // A replaced sheet may retain Done for its old receipt.
                                guard inspections.wrappedValue?.id == presentation.id else { return }
                                inspections.wrappedValue = nil
                            } label: {
                                Text("Done").font(OpenClawType.body)
                            }
                        }
                    }
                }
                .onAppear {
                    self.nativeActions?.acknowledgeInspection(
                        presentation,
                        presentationID: self.nativePresentationID)
                }
            }
            .onChange(of: self.appModel.chatSessionKey) { _, _ in self.clearChangedNativeChatSelection() }
            .onChange(of: self.appModel.chatDeliveryAgentId) { _, _ in self.clearChangedNativeChatSelection() }
            .onChange(of: self.appModel.chatTranscriptCacheGatewayID) { _, _ in
                self.clearChangedNativeChatSelection()
            }
            .onChange(of: self.preventSleep) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.appModel.talkMode.isEnabled) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.scenePhase) { _, newValue in
                self.updateIdleTimer()
                guard newValue == .active else {
                    self.clearVoiceWakeToast()
                    return
                }
                self.handleLiveVoiceStartRequest()
                self.maybeRequestLocalNetworkAccess(reason: "scene_active")
                Task {
                    await self.appModel.refreshGatewayOverviewIfConnected()
                }
            }
            .onDisappear {
                if self.pagesEditor != nil {
                    // Pages owns this cover, but never retains a native chat binding.
                    // The exact-ID lifetime anchor still releases actual Root removal.
                    _ = self.nativeActions?.userNavigationDidChange(
                        presentationID: self.nativePresentationID,
                        disposition: .departure)
                } else if self.retainChatModalPresentation() {
                    _ = self.nativeActions?.userNavigationDidChange(
                        presentationID: self.nativePresentationID,
                        disposition: .chatModal)
                } else {
                    self.nativeLifetime.release()
                    self.clearChatModalScope()
                }
                UIApplication.shared.isIdleTimerDisabled = false
                self.clearVoiceWakeToast()
            }
    }

    private func clearChangedNativeChatSelection() {
        guard let binding = self.nativeChatBinding else { return }
        let session = binding.session
        guard self.appModel.chatSessionKey.utf8.elementsEqual(session.sessionKey.utf8),
              self.appModel.chatDeliveryAgentId?.utf8.elementsEqual(session.agentID.utf8) == true,
              self.appModel.chatTranscriptCacheGatewayID?.utf8
                  .elementsEqual(session.owner.gatewayID.utf8) == true
        else {
            self.nativeActions?.retireChatSelection(presentationID: self.nativePresentationID)
            return
        }
    }

    private func clearVoiceWakeToast() {
        self.voiceWakeToastText = nil
        self.toastDismissGate.cancel()
    }

    private func rootGatewayProblemLifecycle(_ content: some View) -> some View {
        content
            .onChange(of: self.appModel.lastGatewayProblem) { _, newValue in
                if newValue == nil {
                    self.isGatewayToastSwipeDismissed = false
                }
            }
            .onChange(of: self.appModel.gatewayProblemReportCount) { _, _ in
                self.handleGatewayProblemReport()
            }
    }

    private func rootGatewayLifecycle(_ content: some View) -> some View {
        self.rootGatewayProblemLifecycle(content)
            .onChange(of: self.gatewayController.gateways.count) { _, _ in self.maybeShowQuickSetup() }
            .onChange(of: self.appModel.gatewayServerName) { _, newValue in
                if newValue != nil {
                    self.onboardingComplete = true
                    self.hasConnectedOnce = true
                    OnboardingStateStore.markCompleted(mode: nil)
                }
                self.maybeAutoOpenSettings()
                self.maybeShowQuickSetup()
            }
    }

    private func rootRequestLifecycle(_ content: some View) -> some View {
        let isCurrent = navigationContext()
        let action = navigationAction()
        return content
            .onChange(of: self.onboardingRequestID) { _, _ in
                self.evaluateOnboardingPresentation(force: true)
            }
            .onChange(of: self.showOnboarding) { _, newValue in
                guard !newValue else { return }
                self.maybeRequestLocalNetworkAccess(reason: "onboarding_dismissed")
            }
            .onChange(of: self.appModel.pendingLiveVoiceStart) { _, _ in
                self.handleLiveVoiceStartRequest()
            }
            .onChange(of: self.appModel.openChatRequestID) { _, newValue in
                guard isCurrent(), self.appModel.consumeOpenChatRequest(newValue), action() else { return }
                self.selectSidebarDestination(.chat)
            }
            .onChange(of: self.appModel.dashboardNavigationRequestID) { _, requestID in
                guard isCurrent(), self.appModel.consumeDashboardNavigationRequest(requestID), action() else { return }
                self.selectSidebarDestination(.overview)
            }
            .onChange(of: self.appModel.gatewaySetupRequestID) { _, _ in
                guard isCurrent() else { return }
                self.maybeOpenSettingsForGatewaySetup(onAccepted: action)
            }
            .onChange(of: NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt)) { _, newValue in
                if newValue != self.suppressedExecApprovalForNotificationSettings {
                    self.suppressedExecApprovalForNotificationSettings = nil
                }
            }
    }

    private func rootPresentation(_ content: some View) -> some View {
        let action = navigationAction()
        let sheets = self.chatSheetBinding
        return content
            .sheet(isPresented: userModalBinding(self.$showGatewayProblemDetails)) {
                if let gatewayProblem = self.appModel.lastGatewayProblem {
                    GatewayProblemDetailsSheet(
                        problem: gatewayProblem,
                        primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                        onPrimaryAction: {
                            self.handleGatewayProblemPrimaryAction(gatewayProblem, onNavigate: action)
                        })
                }
            }
            .sheet(item: sheets) { sheet in
                let sheetAction: @MainActor @Sendable () -> Bool = {
                    guard self.presentedSheet == sheet else { return false }
                    if let receipt = sheet.chatReceipt {
                        return receipt.retireIfCurrent()
                    }
                    return action()
                }
                Group {
                    switch sheet {
                    case .quickSetup:
                        GatewayQuickSetupSheet(onUseManualSetup: {
                            guard sheetAction() else { return }
                            self.presentedSheet = nil
                            self.selectSettingsRoute(.gateway)
                        })
                        .environment(self.appModel)
                        .environment(self.gatewayController)
                        .openClawSheetChrome()
                    case let .notificationSettings(path):
                        DashboardPageScreen(
                            path: path,
                            title: String(localized: "Notifications"),
                            onClose: { sheets.wrappedValue = nil })
                    case let .sessionDashboard(sessionKey, agentId):
                        NavigationStack {
                            SessionDashboardScreen(sessionKey: sessionKey, agentId: agentId)
                        }
                    case let .backgroundTasks(agentID, receipt):
                        self.chatModalContent(receipt) { BackgroundTasksScreen(agentID: agentID) }
                    case let .newSessionOptions(viewModel, receipt):
                        self.chatModalContent(receipt) {
                            ChatNewSessionOptionsPopover(viewModel: viewModel) {
                                self.dismissChatModal(receipt)
                            }
                            .presentationDetents([.medium])
                            .presentationDragIndicator(.visible)
                        }
                    case let .transcriptShare(fileURL, receipt):
                        self.chatModalContent(receipt) { OpenClawChatFileShareSheet(fileURL: fileURL) }
                    }
                }
                .environment(\.userNavigationAction, sheetAction)
            }
            .alert(
                String(localized: "Unable to Export Transcript"),
                isPresented: self.transcriptExportErrorBinding)
            {
                let receipt = self.transcriptExportError
                Button(role: .cancel) {
                    if let receipt { self.dismissChatModal(receipt) }
                } label: {
                    Text("OK").font(OpenClawType.body)
                }
            } message: {
                Text("OpenClaw could not prepare the Markdown file.").font(OpenClawType.body)
            }
            .fullScreenCover(isPresented: self.$showOnboarding) {
                    OnboardingWizardView(
                        allowSkip: self.onboardingAllowSkip,
                        onRequestLocalNetworkAccess: { reason in
                            self.requestLocalNetworkAccess(reason: reason)
                        },
                        onClose: {
                            self.showOnboarding = false
                        },
                        onComplete: {
                            self.showOnboarding = false
                            self.selectSidebarDestination(.chat)
                        })
                        .environment(self.appModel)
                        .environment(self.voiceWake)
                        .environment(self.gatewayController)
                }
                .gatewayTrustPromptAlert(isEnabled: !self.showOnboarding)
                .deepLinkAgentPromptAlert()
                .execApprovalPromptDialog(
                    suppressedApproval: self.activeExecApprovalPromptSuppression)
                .notificationPermissionGuidanceDialog(openNotifications: notificationSettingsAction())
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled =
            self.scenePhase == .active && (self.preventSleep || self.appModel.talkMode.isEnabled)
    }
}

extension RootTabs {
    private var currentChatModalScope: ChatModalScope? {
        guard self.selectedSidebarDestination == .chat,
              let viewModel = self.appModel.chatPresentation.viewModel else { return nil }
        return ChatModalScope(
            origin: .init(viewModel: viewModel),
            shellID: self.sidebarDetailShellID,
            ownerID: self.appModel.chatViewModelOwnerID,
            sessionKey: self.appModel.chatSessionKey,
            agentID: self.appModel.chatDeliveryAgentId,
            accountGeneration: self.appModel.operatorAuthorityGeneration,
            inputs: self.appModel.activeGatewayConnectConfig?.controlUIInputs)
    }

    private func clearChatModalScope() {
        if let scope = self.chatModalScope { self.chatModals.invalidate(origin: scope.origin) }
        if self.presentedSheet?.chatReceipt != nil { self.presentedSheet = nil }
        self.transcriptExportError = nil
        self.chatModalScope = nil
    }

    private func synchronizeChatModalScope() {
        let current = self.currentChatModalScope
        guard self.chatModalScope != current else { return }
        self.clearChatModalScope()
        self.chatModalScope = current
        if let current { self.chatModals.synchronize(origin: current.origin) }
    }

    private var chatModalActions: OpenClawChatModalActions {
        let scope = self.currentChatModalScope
        let contextIsCurrent = self.navigationContext(detail: true)
        let container = self.presentedSheet
        let inspection = self.nativeRunInspection
        return Self.makeChatModalActions(
            origin: scope?.origin,
            router: self.nativeActions,
            rootID: self.nativePresentationID,
            isCurrentScope: { scope == self.currentChatModalScope && contextIsCurrent() },
            isCurrentContainer: {
                self.presentedSheet == container && self.nativeRunInspection == inspection &&
                    self.transcriptExportError == nil && !self.showOnboarding &&
                    !self.showGatewayProblemDetails && self.appModel.pendingExecApprovalPrompt == nil &&
                    self.appModel.pendingNotificationPermissionGuidancePrompt == nil &&
                    self.appModel.pendingAgentDeepLinkPrompt == nil &&
                    self.gatewayController.pendingTrustPrompt == nil
            })
    }

    /// Shared sheets carry this frozen root context through async publication and
    /// dismissal. A retained callback can never borrow a replacement registration.
    static func makeChatModalActions(
        origin: OpenClawChatModalOrigin?,
        router: NativeActionRouter?,
        rootID: UUID?,
        isCurrentScope: @escaping @MainActor () -> Bool,
        isCurrentContainer: @escaping @MainActor () -> Bool) -> OpenClawChatModalActions
    {
        let isCurrent: @MainActor (OpenClawChatModalOrigin) -> Bool = {
            origin == $0 && isCurrentScope() &&
                (router == nil || router?.capturePresentationAuthority(rootID) != nil)
        }
        return OpenClawChatModalActions(
            capture: { requested in
                guard isCurrent(requested), isCurrentContainer() else { return nil }
                let authority = router?.capturePresentationAuthority(rootID)
                let permitIsCurrent: @MainActor () -> Bool = {
                    isCurrent(requested) && isCurrentContainer() &&
                        (router == nil || authority.map { router?.isCurrentPresentation($0) == true } == true)
                }
                return .init(isCurrent: permitIsCurrent, accept: {
                    guard permitIsCurrent() else { return false }
                    return router?.userNavigationDidChange(
                        presentationID: rootID,
                        disposition: .chatModal) ?? true
                })
            },
            dismiss: { requested in
                guard isCurrent(requested) else { return }
                _ = router?.userNavigationDidChange(presentationID: rootID, disposition: .chatModal)
            },
            isCurrent: isCurrent)
    }

    private func retainChatModalPresentation() -> Bool {
        // Reset actual target/account departure before treating disappearance as cover.
        self.synchronizeChatModalScope()
        guard let scope = self.chatModalScope else { return false }
        return self.chatModals.hasActivePresentation(for: scope.origin) ||
            self.presentedSheet?.chatReceipt?.origin == scope.origin ||
            self.transcriptExportError?.origin == scope.origin
    }

    private func prepareChatModal(_ viewModel: OpenClawChatViewModel) -> IOSChatModalPublication? {
        self.synchronizeChatModalScope()
        guard self.appModel.chatPresentation.viewModel === viewModel,
              let scope = self.chatModalScope, self.presentedSheet == nil,
              self.transcriptExportError == nil, !self.chatModals.hasActivePresentation,
              let capture = self.chatModals.capture(
                  origin: scope.origin,
                  producerID: UUID(),
                  actions: self.chatModalActions)
        else { return nil }
        return IOSChatModalPublication(
            isCurrent: { capture.isCurrent },
            present: { request in
                guard self.presentedSheet == nil, self.transcriptExportError == nil,
                      capture.accept() else { return }
                let receipt = capture.receipt
                switch request {
                case let .backgroundTasks(agentID):
                    self.presentedSheet = .backgroundTasks(agentID: agentID, receipt: receipt)
                case let .newSessionOptions(viewModel):
                    self.presentedSheet = .newSessionOptions(viewModel, receipt: receipt)
                case let .transcriptShare(fileURL):
                    self.presentedSheet = .transcriptShare(fileURL, receipt: receipt)
                case .transcriptExportError:
                    self.transcriptExportError = receipt
                }
            })
    }

    private func dismissChatModal(_ receipt: OpenClawChatModalPresentations.Receipt) {
        guard self.presentedSheet?.chatReceipt?.id == receipt.id ||
            self.transcriptExportError?.id == receipt.id else { return }
        receipt.retireIfCurrent()
        self.chatModals.removeDescendants(of: receipt)
        if self.presentedSheet?.chatReceipt?.id == receipt.id { self.presentedSheet = nil }
        if self.transcriptExportError?.id == receipt.id { self.transcriptExportError = nil }
    }

    private var chatSheetBinding: Binding<PresentedSheet?> {
        let expected = self.presentedSheet
        let ordinary = self.userModalBinding(self.$presentedSheet)
        return Binding(get: { self.presentedSheet }, set: { value in
            guard self.presentedSheet == expected else { return }
            if let receipt = expected?.chatReceipt, value == nil {
                self.dismissChatModal(receipt)
            } else {
                ordinary.wrappedValue = value
            }
        })
    }

    private var transcriptExportErrorBinding: Binding<Bool> {
        let receipt = self.transcriptExportError
        return Binding(get: { self.transcriptExportError != nil }, set: { value in
            if !value, let receipt { self.dismissChatModal(receipt) }
        })
    }

    private func chatModalContent(
        _ receipt: OpenClawChatModalPresentations.Receipt,
        @ViewBuilder content: () -> some View) -> some View
    {
        content().openClawChatModalPresentations(
            self.chatModals,
            origin: receipt.origin,
            actions: self.chatModalActions,
            parent: receipt,
            parentIsCurrent: { self.presentedSheet?.chatReceipt?.id == receipt.id })
    }

    /// Freeze the root and (for detail callbacks) stack that produced this action.
    /// A callback retained by a departed view cannot act for a replacement root.
    private func navigationContext(detail: Bool = false) -> @MainActor @Sendable () -> Bool {
        let router = self.nativeActions
        let rootID = self.nativePresentationID
        let shellID = detail ? self.sidebarDetailShellID : nil
        return {
            (router == nil || router?.capturePresentationAuthority(rootID) != nil) &&
                (shellID == nil || shellID == self.sidebarDetailShellID)
        }
    }

    private func navigationAction(
        detail: Bool = false,
        disposition: NativeActionRouter.RetirementDisposition = .departure)
        -> @MainActor @Sendable () -> Bool
    {
        let isCurrent = self.navigationContext(detail: detail)
        let router = self.nativeActions
        let rootID = self.nativePresentationID
        return {
            guard isCurrent() else { return false }
            return router?.userNavigationDidChange(presentationID: rootID, disposition: disposition) ?? true
        }
    }

    private func userAction(
        detail: Bool = false,
        disposition: NativeActionRouter.RetirementDisposition = .departure,
        _ perform: @escaping @MainActor () -> Void) -> @MainActor () -> Void
    {
        let action = self.navigationAction(detail: detail, disposition: disposition)
        return {
            guard action() else { return }
            perform()
        }
    }

    private func userDestinationAction(_ destination: SidebarDestination) -> @MainActor () -> Void {
        self.userAction(detail: true) { self.selectSidebarDestination(destination) }
    }

    private var userSettingsPath: Binding<[SettingsRoute]> {
        let action = self.navigationAction(detail: true)
        return Binding(get: { self.sidebarNavigationPath }, set: { path in
            guard path != self.sidebarNavigationPath, action() else { return }
            self.sidebarNavigationPath = path
        })
    }

    private func userModalBinding<Value: Equatable>(_ binding: Binding<Value>) -> Binding<Value> {
        Self.matchedModalBinding(binding, admit: self.navigationAction())
    }

    static func matchedModalBinding<Value: Equatable>(
        _ binding: Binding<Value>,
        admit: @escaping @MainActor () -> Bool) -> Binding<Value>
    {
        let expected = binding.wrappedValue
        return Binding(get: { binding.wrappedValue }, set: { value in
            guard value != binding.wrappedValue, binding.wrappedValue == expected, admit() else { return }
            binding.wrappedValue = value
        })
    }

    private func notificationSettingsAction(detail: Bool = false) -> (String?) -> Void {
        let action = self.navigationAction(detail: detail)
        return { approvalID in
            guard action() else { return }
            self.openNotificationSettings(approvalID)
        }
    }

    private func chatTarget(_ session: OpenClawChatSessionEntry) -> OpenClawChatSessionTarget {
        IOSGatewayChatTransport.sessionTarget(
            for: session.key,
            selectedAgentID: self.appModel.chatDeliveryAgentId,
            overrideAgentID: session.agentId)
    }

    private func commitChatNavigation(_ target: OpenClawChatSessionTarget) {
        self.appModel.focusChatSession(target)
        self.appModel.openChat(sessionKey: target.sessionKey)
        // UI navigation is already admitted. Its request projection must not retire
        // a newer native action when SwiftUI delivers the later onChange callback.
        _ = self.appModel.consumeOpenChatRequest(self.appModel.openChatRequestID)
        self.selectSidebarDestination(.chat)
    }

    private func openChatAction(detail: Bool = false) -> (OpenClawChatSessionTarget) -> Void {
        let action = self.navigationAction(detail: detail)
        return { target in
            guard action() else { return }
            self.commitChatNavigation(target)
        }
    }

    private func prepareForkAction(detail: Bool = false) -> (OpenClawChatSessionEntry) -> PreparedChatNavigation? {
        let action = self.navigationAction(detail: detail)
        let context = self.navigationContext(detail: detail)
        let router = self.nativeActions
        let rootID = self.nativePresentationID
        return { session in
            guard action() else { return nil }
            return PreparedChatNavigation.capture(
                appModel: self.appModel,
                router: router,
                presentationID: rootID,
                session: session,
                isCurrentContext: context,
                currentNativeBinding: { self.nativeChatBinding },
                open: { self.commitChatNavigation($0) })
        }
    }

    private func selectSidebarSession(_ session: OpenClawChatSessionEntry) {
        switch Self.sidebarPresentation(for: session) {
        case .chat:
            self.commitChatNavigation(self.chatTarget(session))
        case .dashboard:
            let target = Self.sidebarDashboardTarget(for: session)
            self.presentedSheet = .sessionDashboard(
                sessionKey: target.sessionKey,
                agentId: target.agentId)
            guard self.shouldCollapseSidebarAfterSelection else { return }
            withAnimation(self.sidebarAnimation) {
                self.setSidebarVisible(false)
            }
        }
    }

    private func selectSidebarDestination(_ destination: SidebarDestination) {
        // Replace stale stack callbacks without remounting an unchanged native Chat.
        if self.selectedSidebarDestination != destination || !self.sidebarNavigationPath.isEmpty {
            self.selectedSettingsRouteRequestID &+= 1
        }
        self.sidebarNavigationPath.removeAll()
        self.suppressedExecApprovalForNotificationSettings = nil
        self.selectedSidebarDestination = destination
        self.selectedSettingsRoute = destination.settingsRoute
        self.activeSettingsRoute = destination.settingsRoute
        guard self.shouldCollapseSidebarAfterSelection else { return }
        withAnimation(self.sidebarAnimation) {
            self.setSidebarVisible(false)
        }
    }

    private func handleLiveVoiceStartRequest() {
        guard self.didApplyInitialChatSession, self.didEvaluateOnboarding,
              self.scenePhase == .active, self.appModel.pendingLiveVoiceStart
        else { return }
        if !self.showOnboarding {
            self.presentedSheet = nil
            self.showGatewayProblemDetails = false
        }
        self.appModel.consumeLiveVoiceStartRequest(
            isSceneActive: true,
            isOnboardingPresented: self.showOnboarding,
            hasGatewayConfiguration: self.hasExistingGatewayConfig() || self.appModel.gatewayServerName != nil)
    }

    private func selectSettingsRoute(_ route: SettingsRoute) {
        self.sidebarNavigationPath.removeAll()
        self.suppressedExecApprovalForNotificationSettings = nil
        self.selectedSettingsRoute = nil
        self.activeSettingsRoute = route
        self.selectedSettingsRouteRequestID &+= 1
        self.selectedSidebarDestination = .settings
        self.sidebarNavigationPath = [route]
        guard self.shouldCollapseSidebarAfterSelection else { return }
        withAnimation(self.sidebarAnimation) {
            self.setSidebarVisible(false)
        }
    }

    private func openNotificationSettings(_ approvalID: String?) {
        if let approvalID {
            self.suppressExecApprovalPromptForNotificationSettings(approvalID)
        }
        let path = Self.notificationSettingsPath(
            servingEnabled: NotificationServingPreference.isEnabled(),
            disclosureAccepted: !PushBuildConfig.current.usesOpenClawHostedRelay
                || PushEnrollmentConsent.disclosureAccepted)
        self.presentedSheet = .notificationSettings(path: path)
    }

    private func suppressExecApprovalPromptForNotificationSettings(_ approvalID: String) {
        guard let approvalID = ExecApprovalIdentifier.key(approvalID),
              let prompt = self.appModel.pendingExecApprovalPrompt,
              ExecApprovalIdentifier.key(prompt.id) == approvalID
        else { return }
        self.suppressedExecApprovalForNotificationSettings = NodeAppModel.execApprovalInboxKey(prompt)
    }

    private func handleSettingsRouteChange(_ route: SettingsRoute?) {
        self.activeSettingsRoute = route
        if route == nil {
            self.selectedSettingsRoute = nil
            if self.selectedSidebarDestination == .settings {
                self.selectedSidebarDestination = .settings
            }
        }
        self.suppressedExecApprovalForNotificationSettings = nil
    }

    private func handleSidebarSettingsNavigationPathChange(_ navigationPath: [SettingsRoute]) {
        guard self.selectedSidebarDestination == .settings || self.selectedSidebarDestination == .gateway else {
            return
        }
        let baseRoute = self.selectedSettingsRoute ?? self.selectedSidebarDestination.settingsRoute
        let route = Self.visibleSettingsRoute(
            navigationPath: navigationPath,
            baseRoute: baseRoute)
        self.handleSettingsRouteChange(route)
    }

    private func showSidebar() {
        self.sidebarVisibilityUserOverridden = true
        withAnimation(self.sidebarAnimation) {
            self.setSidebarVisible(true)
        }
    }

    private func hideSidebar() {
        self.sidebarVisibilityUserOverridden = true
        withAnimation(self.sidebarAnimation) {
            self.setSidebarVisible(false)
        }
    }

    private func updateSidebarLayout(containerSize: CGSize, force: Bool) {
        let layoutMode = Self.sidebarLayoutMode(containerSize: containerSize)
        let previousLayoutMode: SidebarLayoutMode = self.isSidebarDrawerLayout ? .drawer : .split
        let didResolvePreviousLayout = self.didResolveSidebarLayout
        let layoutModeDidChange = layoutMode != previousLayoutMode
        self.didResolveSidebarLayout = true
        self.isSidebarDrawerLayout = layoutMode == .drawer
        if layoutModeDidChange && didResolvePreviousLayout {
            self.sidebarVisibilityUserOverridden = false
        }
        guard force || !self.sidebarVisibilityUserOverridden else { return }

        let preferredVisibility = Self.preferredSidebarVisibility(layoutMode: layoutMode)
        guard self.isSidebarVisible != preferredVisibility else { return }
        self.setSidebarVisible(preferredVisibility)
    }

    private func setSidebarVisible(_ isVisible: Bool) {
        self.isSidebarVisible = isVisible
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String? {
        GatewayProblemPrimaryAction.title(
            for: problem,
            retryTitle: "Retry",
            resetTitle: "Reset onboarding",
            nonRetryableTitle: "Open Settings")
    }

    private func handleGatewayProblemPrimaryAction(
        _ problem: GatewayConnectionProblem,
        onNavigate: () -> Bool)
    {
        if problem.suggestsOnboardingReset {
            // Reset bumps onboarding.requestID, which re-presents the wizard.
            let instanceId = UserDefaults.standard.string(forKey: "node.instanceId") ?? ""
            Task {
                await GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: instanceId)
            }
        } else if problem.canTrustRotatedCertificate {
            Task { await self.gatewayController.trustRotatedGatewayCertificate(from: problem) }
        } else if GatewayProblemPrimaryAction.handleProtocolMismatchIfNeeded(problem) {
            return
        } else if problem.retryable {
            self.gatewayRetryFailure = nil
            Task {
                if case let .failed(message) = await self.gatewayController.retryGatewayConnection() {
                    self.gatewayRetryFailure = message
                }
            }
        } else {
            guard onNavigate() else { return }
            self.selectSidebarDestination(.gateway)
        }
    }

    private func evaluateOnboardingPresentation(force: Bool) {
        if force {
            self.onboardingAllowSkip = true
            self.showOnboarding = true
            return
        }

        guard !self.didEvaluateOnboarding else { return }
        self.didEvaluateOnboarding = true
        let route = Self.startupPresentationRoute(
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            shouldPresentOnLaunch: OnboardingStateStore.shouldPresentOnLaunch(appModel: self.appModel))
        switch route {
        case .none:
            self.maybeRequestLocalNetworkAccess(reason: "root_appear")
        case .onboarding:
            self.onboardingAllowSkip = true
            self.showOnboarding = true
        case .settings:
            self.didAutoOpenSettings = true
            self.selectSidebarDestination(.gateway)
            self.maybeRequestLocalNetworkAccess(reason: "root_appear")
        }
    }

    private func hasExistingGatewayConfig() -> Bool {
        if self.appModel.activeGatewayConnectConfig != nil { return true }
        if GatewaySettingsStore.activeGatewayEntry() != nil { return true }

        let preferredStableID = self.preferredGatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        if !preferredStableID.isEmpty { return true }

        let manualHost = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.manualGatewayEnabled && !manualHost.isEmpty
    }

    private func maybeAutoOpenSettings() {
        guard !self.didAutoOpenSettings else { return }
        guard !self.showOnboarding else { return }
        let route = Self.startupPresentationRoute(
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            shouldPresentOnLaunch: false)
        guard route == .settings else { return }
        self.didAutoOpenSettings = true
        self.selectSidebarDestination(.gateway)
        self.maybeRequestLocalNetworkAccess(reason: "auto_open_settings")
    }

    private func maybeOpenSettingsForGatewaySetup(onAccepted: () -> Bool = { true }) {
        let requestID = self.appModel.gatewaySetupRequestID
        guard requestID != 0, requestID != self.gatewaySetupRequest?.id else { return }
        // The presented onboarding flow owns setup-link staging until it dismisses.
        guard !self.showOnboarding else { return }
        guard let link = appModel.consumePendingGatewaySetupLink(), onAccepted() else { return }
        self.showOnboarding = false
        self.presentedSheet = nil
        self.didAutoOpenSettings = true
        self.selectSidebarDestination(.gateway)
        // Root owns delivery so embedded Settings views cannot consume the one-shot link.
        self.gatewaySetupRequest = GatewaySetupRequest(id: requestID, link: link)
        self.requestLocalNetworkAccess(reason: "gateway_setup_deeplink")
    }

    private func handleGatewaySetupRequest(_ requestID: Int) {
        guard self.gatewaySetupRequest?.id == requestID else { return }
        self.gatewaySetupRequest = nil
    }

    private func maybeRequestLocalNetworkAccess(reason: String) {
        guard self.didEvaluateOnboarding else { return }
        guard self.scenePhase == .active else { return }
        guard !self.showOnboarding else { return }
        self.requestLocalNetworkAccess(reason: reason)
    }

    private func requestLocalNetworkAccess(reason: String) {
        guard !self.appModel.isAppleReviewDemoModeEnabled else { return }
        self.gatewayController.requestLocalNetworkAccess(reason: reason)
    }

    private func applyInitialChatSessionIfNeeded() {
        guard !self.didApplyInitialChatSession else { return }
        self.didApplyInitialChatSession = true
        self.appModel.focusChatSession(Self.initialChatSessionKey)
    }

    private func maybeShowQuickSetup() {
        let shouldPresent = Self.shouldPresentQuickSetup(
            quickSetupDismissed: self.quickSetupDismissed,
            showOnboarding: self.showOnboarding,
            hasPresentedSheet: self.presentedSheet != nil,
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            discoveredGatewayCount: self.gatewayController.gateways.count)
        guard shouldPresent else { return }
        self.presentedSheet = .quickSetup
    }
}

private struct RootCameraFlashOverlay: View {
    @Environment(\.scenePhase) private var scenePhase

    var nonce: Int

    @State private var opacity: CGFloat = 0
    @State private var dismissGate = DelayedActionGate()

    var body: some View {
        Color.white
            .opacity(self.opacity)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .onChange(of: self.nonce) { _, _ in
                guard self.scenePhase == .active else {
                    self.clearFlash()
                    return
                }
                self.showFlash()
            }
            .onChange(of: self.scenePhase) { _, newValue in
                guard newValue != .active else { return }
                self.clearFlash()
            }
            .onDisappear { self.clearFlash() }
    }

    private func showFlash() {
        withAnimation(.easeOut(duration: 0.08)) {
            self.opacity = 0.85
        }
        self.dismissGate.schedule(after: .milliseconds(110)) {
            withAnimation(.easeOut(duration: 0.32)) {
                self.opacity = 0
            }
        }
    }

    private func clearFlash() {
        self.opacity = 0
        self.dismissGate.cancel()
    }
}
