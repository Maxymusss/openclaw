import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit

@MainActor
@Observable
final class NativeActionRouter: OpenClawNativeActionHost {
    /// The current single scene acknowledges presentation here. Scene ownership
    /// can replace this callback without changing the intent or submission owner.
    struct RunPresentation: Identifiable, Equatable {
        let id = UUID()
        let inspection: OpenClawNativeRunInspection
    }

    enum RetirementDisposition: Sendable {
        case departure
        case chatModal
        case chatSessionTransition
    }

    private enum Preparation {
        case waitingForRoot
        case registeredRoot(id: UUID, navigationRevision: UInt64)
    }

    typealias PresentationHandler = @MainActor (
        OpenClawNativeOpenRequest, IOSNativeActionBinding, RunPresentation?) throws -> Void
    @ObservationIgnored private var presentation: (
        id: UUID, open: PresentationHandler, retire: @MainActor (RetirementDisposition) -> Void,
        adopt: @MainActor (IOSNativeActionBinding, IOSNativeActionBinding) -> Void)?
    private var inspectionPresentation: RunPresentation?
    @ObservationIgnored private var presentedInspectionID: UUID?
    private var selectionID = UUID()
    @ObservationIgnored private var navigationRevision: UInt64 = 0
    @ObservationIgnored private let appModel: NodeAppModel
    @ObservationIgnored private let gatewayController: GatewayConnectionController
    @ObservationIgnored private weak var chat: OpenClawChatViewModel?
    @ObservationIgnored private var chatOwnerID: String?
    @ObservationIgnored private var chatAgentID: String?
    @ObservationIgnored private var chatTransport: IOSGatewayChatTransport?
    // Account loss must reach retained callers after the chat unregisters.
    // Presentation departure retires selection, not this captured account lifetime.
    @ObservationIgnored private var accountBinding: IOSNativeActionBinding?
    @ObservationIgnored private var chatPresentationID: UUID?
    private(set) var chatRegistrationID: UUID?
    @ObservationIgnored private var preparation: Preparation?

    var presentationRegistrationID: UUID? {
        self.presentation?.id
    }

    init(appModel: NodeAppModel, gatewayController: GatewayConnectionController) {
        self.appModel = appModel
        self.gatewayController = gatewayController
        appModel.chatSelectionDidChange = { [weak self] in
            self?.navigationRevision &+= 1
            self?.retireChatSelection()
        }
    }

    @discardableResult
    func registerPresentation(
        onRetire: @escaping @MainActor (RetirementDisposition) -> Void,
        onSessionAdopted: @escaping @MainActor (IOSNativeActionBinding, IOSNativeActionBinding) -> Void = { _, _ in },
        _ handler: @escaping PresentationHandler) -> UUID
    {
        let id = UUID()
        self.presentation = (id, handler, onRetire, onSessionAdopted)
        // A cold action belongs to the first Root that becomes ready, even if
        // navigation replaces that Root before its suspended preparation resumes.
        if case .waitingForRoot? = self.preparation {
            self.preparation = .registeredRoot(id: id, navigationRevision: self.navigationRevision)
        }
        return id
    }

    func unregisterPresentation(_ id: UUID) {
        guard self.presentation?.id == id else { return }
        // Retire even before a chat registers, while its host cleanup is reachable.
        self.clearRegisteredChat()
        self.presentation = nil
    }

    func registerChat(
        _ chat: OpenClawChatViewModel,
        ownerID: String,
        agentID: String,
        transport: IOSGatewayChatTransport?,
        presentationID: UUID?) -> UUID?
    {
        guard let presentationID, self.presentation?.id == presentationID else { return nil }
        let registrationID = UUID()
        self.chatRegistrationID = registrationID
        self.chat = chat
        self.chatOwnerID = ownerID
        self.chatAgentID = agentID
        self.chatTransport = transport
        self.chatPresentationID = presentationID
        return registrationID
    }

    func unregisterChat(_ registrationID: UUID?) {
        // Successive visible views may share the root-owned model and presentation.
        // A disappearing view can retire only the registration it acquired.
        guard let registrationID, self.chatRegistrationID == registrationID else { return }
        self.clearRegisteredChat()
    }

    private func clearRegisteredChat() {
        self.navigationRevision &+= 1
        self.chatRegistrationID = nil
        self.chat = nil
        self.chatOwnerID = nil
        self.chatAgentID = nil
        self.chatTransport = nil
        self.chatPresentationID = nil
        self.retireChatSelection()
    }

    struct PresentationAuthority {
        fileprivate let rootID: UUID
        fileprivate let selectionID: UUID
    }

    func capturePresentationAuthority(_ id: UUID?) -> PresentationAuthority? {
        guard let id, self.presentation?.id == id else { return nil }
        return PresentationAuthority(rootID: id, selectionID: self.selectionID)
    }

    func isCurrentPresentation(_ authority: PresentationAuthority) -> Bool {
        self.presentation?.id == authority.rootID && self.selectionID == authority.selectionID
    }

    func hasRegisteredChat(
        _ chat: OpenClawChatViewModel,
        binding: IOSNativeActionBinding,
        authority: PresentationAuthority) -> Bool
    {
        self.isCurrentPresentation(authority) && self.chatRegistrationID != nil &&
            self.chatPresentationID == authority.rootID && self.matches(chat, session: binding.session) &&
            self.chatTransport?.nativeBinding?.canReuse(binding) == true
    }

    func captureSessionTransitionAuthority(
        _ chat: OpenClawChatViewModel,
        binding: IOSNativeActionBinding,
        presentationID: UUID?) -> @MainActor () -> Bool
    {
        let selectionID = self.selectionID
        let accountAuthority = self.currentAccountAuthority
        return { [weak self, weak chat] in
            guard let self, let chat, let presentationID else { return false }
            return self.presentation?.id == presentationID && self.selectionID == selectionID &&
                self.currentAccountAuthority == accountAuthority &&
                self.chatPresentationID == presentationID && self.matches(chat, session: binding.session) &&
                self.chatTransport?.nativeBinding?.canReuse(binding) == true
        }
    }

    func chatSessionChanged(
        _ chat: OpenClawChatViewModel,
        binding: IOSNativeActionBinding,
        transport: IOSGatewayChatTransport,
        presentationID: UUID?) -> Bool
    {
        // The shared owner already admitted this synchronous adoption. Keep its
        // model, retire parent confirmations, then publish the exact child binding.
        let target = chat.currentSessionTarget
        guard let presentationID, let presentation, presentation.id == presentationID,
              let registrationID = self.chatRegistrationID,
              self.chatPresentationID == presentationID, self.chat === chat,
              self.chatOwnerID == self.appModel.chatViewModelOwnerID,
              self.chatTransport?.nativeBinding?.canReuse(binding) == true,
              let next = transport.nativeBinding,
              binding.scoped(to: target)?.canReuse(next) == true,
              self.appModel.chatSessionKey.utf8.elementsEqual(binding.session.sessionKey.utf8),
              self.appModel.chatDeliveryAgentId?.utf8.elementsEqual(binding.session.agentID.utf8) == true
        else { return false }
        self.appModel.focusChatSession(target)
        // Focus clears Root's old binding, but does not unregister this visible model.
        guard self.presentation?.id == presentationID, self.chatRegistrationID == registrationID,
              self.chat === chat, self.chatOwnerID == self.appModel.chatViewModelOwnerID,
              binding.scoped(to: target)?.canReuse(next) == true,
              self.appModel.chatSessionKey.utf8.elementsEqual(next.session.sessionKey.utf8),
              self.appModel.chatDeliveryAgentId?.utf8.elementsEqual(next.session.agentID.utf8) == true
        else { return false }
        self.chatTransport = transport
        self.chatAgentID = next.session.agentID
        self.accountBinding = next
        presentation.adopt(binding, next)
        return true
    }

    func retireChatSelection(presentationID: UUID?) {
        guard let presentationID, self.presentation?.id == presentationID else { return }
        self.retireChatSelection()
    }

    @discardableResult
    func userNavigationDidChange(
        presentationID: UUID?, disposition: RetirementDisposition = .departure) -> Bool
    {
        guard let presentationID, presentation?.id == presentationID else { return false }
        // User navigation can supersede preparation while Chat is already hidden,
        // when neither view departure nor a model target change records the choice.
        self.navigationRevision &+= 1
        self.retireChatSelection(disposition)
        return true
    }

    private func retireChatSelection(_ disposition: RetirementDisposition = .departure) {
        // Record departure synchronously: returning to the same target must not
        // revive a confirmation or an inspection waiting for visible appearance.
        self.selectionID = UUID()
        self.inspectionPresentation = nil
        self.presentedInspectionID = nil
        self.presentation?.retire(disposition)
    }

    func acknowledgeInspection(_ receipt: RunPresentation, presentationID: UUID?) {
        guard let presentationID, self.presentation?.id == presentationID,
              self.inspectionPresentation?.id == receipt.id else { return }
        self.presentedInspectionID = receipt.id
    }

    func isInspectionPresented(_ receipt: RunPresentation) -> Bool {
        self.inspectionPresentation?.id == receipt.id && self.presentedInspectionID == receipt.id
    }

    func sessions(matching query: String?) async throws -> [OpenClawNativeSessionChoice] {
        let captured = try await self.captureCurrentGateway()
        return try await captured.gateway.sessions(matching: query)
    }

    func runs(matching query: String?) async throws -> [OpenClawNativeRunRef] {
        let captured = try await self.captureCurrentGateway()
        return try await captured.gateway.runs(matching: query)
    }

    func open(_ request: OpenClawNativeOpenRequest) async -> OpenClawNativeOpenOutcome {
        do {
            let presented = try await self.present(request)
            switch request {
            case let .compose(_, draft):
                if let draft {
                    guard !self.appModel.isChatDictationPending, !self.appModel.isChatDictationActive else {
                        throw OpenClawNativeActionError(
                            "Finish or cancel dictation before composing another message.")
                    }
                    let chat = presented.chat
                    guard chat.input.isEmpty, chat.replyTarget == nil,
                          !chat.hasDraftToSend, !chat.isAttachmentOwnerPinned
                    else {
                        throw OpenClawNativeActionError(
                            "Keep or send the current draft before composing another message.")
                    }
                    chat.input = draft
                }
            case .session, .inspect:
                break
            }
            return .opened
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .unavailable(reason: error.localizedDescription)
        }
    }

    func prepareSend(
        to session: OpenClawNativeSessionRef,
        message: String) async throws -> OpenClawNativePreparedSend
    {
        let presented = try await self.present(.session(session))
        let lease: OpenClawChatTransportRouteLease
        switch await presented.transport.acquireOutboxRouteLease(ifCurrentRoute: presented.binding.route) {
        case let .available(value): lease = value
        case let .unavailable(reason, _):
            throw OpenClawNativeActionError(reason ?? "The selected Gateway is disconnected. Nothing was queued.")
        }
        return try await presented.gateway.prepareSubmission(
            viewModel: presented.chat,
            session: session,
            message: message,
            lease: lease,
            presentationIsCurrent: { [weak self] in self?.isCurrent(presented) == true })
    }

    func inspect(_ run: OpenClawNativeRunRef) async throws -> OpenClawNativeRunInspection {
        let presented = try await self.present(.inspect(run))
        guard await presented.binding.isCurrent(), self.isCurrent(presented),
              let result = self.inspectionPresentation?.inspection, result.run == run else { throw CancellationError() }
        return result
    }

    private struct CapturedGateway {
        let gateway: OpenClawChatNativeActionGateway
        let route: GatewayNodeSessionRoute
        let retirementReservation: IOSNativeActionBinding.RetirementReservation?
        let bindingGateway: @Sendable (IOSNativeActionBinding) -> OpenClawChatNativeActionGateway
    }

    private struct AccountAuthority: Equatable {
        let generation: UInt64
        let inputs: GatewayConnectConfig.ControlUIInputs?
    }

    private var currentAccountAuthority: AccountAuthority {
        AccountAuthority(
            generation: self.appModel.operatorAuthorityGeneration,
            inputs: self.appModel.activeGatewayConnectConfig?.controlUIInputs)
    }

    private struct PresentedChat {
        let gateway: OpenClawChatNativeActionGateway
        let binding: IOSNativeActionBinding
        let chat: OpenClawChatViewModel
        let transport: IOSGatewayChatTransport
        let presentationID: UUID
        let selectionID: UUID
        let accountAuthority: AccountAuthority
    }

    private func captureCurrentGateway() async throws -> CapturedGateway {
        guard !self.appModel.isScreenshotFixtureModeEnabled, !self.appModel.isAppleReviewDemoModeEnabled,
              let gatewayID = self.appModel.activeGatewayConnectConfig?.effectiveStableID,
              let route = await self.appModel.operatorSession.currentRoute(ifGatewayID: gatewayID)
        else {
            throw OpenClawNativeActionError("Open OpenClaw and connect the selected Gateway, then try again.")
        }
        return self.captureGateway(gatewayID: gatewayID, route: route)
    }

    private func captureGateway(gatewayID: String, route: GatewayNodeSessionRoute) -> CapturedGateway {
        let previousBinding = self.accountBinding
        let retirementReservation = previousBinding?.reserveRetirement()
        let operatorSession = self.appModel.operatorSession
        let observedBinding = previousBinding.flatMap {
            $0.gateway === operatorSession && $0.route == route &&
                $0.session.owner.gatewayID.utf8.elementsEqual(gatewayID.utf8) ? $0 : nil
        }
        let name = GatewaySettingsStore.loadGatewayRegistry().entries.first {
            $0.stableID.utf8.elementsEqual(gatewayID.utf8)
        }?.name ?? gatewayID
        let makeGateway: @Sendable (IOSNativeActionBinding?) -> OpenClawChatNativeActionGateway = { binding in
            OpenClawChatNativeActionGateway(
                gatewayID: gatewayID,
                gatewayName: name,
                supportsProfileBinding: {
                    await operatorSession.supportsServerCapability(.profileBinding, ifCurrentRoute: route) == true
                },
                request: { request, expectedProfileId in
                    try await operatorSession.request(
                        request,
                        ifCurrentRoute: route,
                        distinguishPreDispatchRouteChange: true,
                        expectedProfileId: expectedProfileId)
                },
                isCurrent: { await operatorSession.currentRoute(ifGatewayID: gatewayID) == route },
                onProfileObservation: { binding?.observe($0) })
        }
        // Verification observes the old capture; later confirmation observes the
        // newly admitted binding. Neither facade looks up a successor after an await.
        return CapturedGateway(
            gateway: makeGateway(observedBinding),
            route: route,
            retirementReservation: retirementReservation,
            bindingGateway: { makeGateway($0) })
    }

    private func present(
        _ request: OpenClawNativeOpenRequest) async throws -> PresentedChat
    {
        let session = request.session
        guard self.preparation == nil else {
            throw OpenClawNativeActionError("Another native action is opening a chat. Try again when it finishes.")
        }
        self.preparation = self.presentation.map {
            .registeredRoot(id: $0.id, navigationRevision: self.navigationRevision)
        } ?? .waitingForRoot
        defer { self.preparation = nil }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(10))
        while case .waitingForRoot? = self.preparation, clock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        guard case let .registeredRoot(rootID, navigationRevision)? = self.preparation else {
            throw OpenClawNativeActionError("Open OpenClaw before running this action.")
        }
        /// Connection-owned target projection can retire a binding while switching
        /// Gateways. Explicit navigation and actual host departure cannot be adopted.
        func requireOrigin() throws {
            try Task.checkCancellation()
            guard self.presentation?.id == rootID, self.navigationRevision == navigationRevision else {
                throw CancellationError()
            }
        }
        try requireOrigin()
        try self.requirePreservedDraft(session)
        if self.appModel.activeGatewayConnectConfig?.effectiveStableID.utf8
            .elementsEqual(session.owner.gatewayID.utf8) != true
        {
            let outcome = await self.gatewayController.switchToGateway(stableID: session.owner.gatewayID)
            try requireOrigin()
            switch outcome {
            case .accepted: break
            case let .failed(reason): throw OpenClawNativeActionError(reason)
            case .superseded: throw CancellationError()
            }
        }
        let generation = self.appModel.gatewayConnectGeneration
        var requestedRoute: GatewayNodeSessionRoute?
        while clock.now < deadline {
            try requireOrigin()
            guard generation == self.appModel.gatewayConnectGeneration else { throw CancellationError() }
            if self.appModel.isOperatorGatewayConnected,
               self.appModel.activeGatewayConnectConfig?.effectiveStableID.utf8
                   .elementsEqual(session.owner.gatewayID.utf8) == true
            {
                let route = await self.appModel.operatorSession.currentRoute(ifGatewayID: session.owner.gatewayID)
                try requireOrigin()
                guard generation == self.appModel.gatewayConnectGeneration else { throw CancellationError() }
                if self.appModel.isOperatorGatewayConnected,
                   self.appModel.activeGatewayConnectConfig?.effectiveStableID.utf8
                       .elementsEqual(session.owner.gatewayID.utf8) == true, let route
                {
                    requestedRoute = route
                    break
                }
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        try requireOrigin()
        guard generation == self.appModel.gatewayConnectGeneration else { throw CancellationError() }
        guard !self.appModel.isScreenshotFixtureModeEnabled, !self.appModel.isAppleReviewDemoModeEnabled,
              let requestedRoute
        else { throw OpenClawNativeActionError("Open OpenClaw and connect the selected Gateway, then try again.") }
        // Capture after the authorized Gateway handoff. Equal restored credentials
        // must not revive a request whose account lifetime changed during a read.
        let accountAuthority = self.currentAccountAuthority
        let captured = self.captureGateway(gatewayID: session.owner.gatewayID, route: requestedRoute)
        let run: OpenClawNativeRunRef? = if case let .inspect(run) = request {
            run
        } else { nil }
        let history = try await captured.gateway.history(session: session, runID: run?.runID)
        try requireOrigin()
        guard self.currentAccountAuthority == accountAuthority else { throw CancellationError() }
        let binding = try await IOSNativeActionBinding.capture(
            session: session,
            gateway: self.appModel.operatorSession,
            route: captured.route,
            reservation: captured.retirementReservation)
        guard await binding.isCurrent(), generation == self.appModel.gatewayConnectGeneration,
              self.currentAccountAuthority == accountAuthority
        else { throw CancellationError() }
        // The old Gateway's delayed projection may retire selection during reads.
        // Only the initiating navigation/root authority governs this pre-adoption phase.
        try requireOrigin()
        try self.requirePreservedDraft(session, binding: binding)
        let receipt = try run.map {
            try RunPresentation(inspection: OpenClawChatNativeRunInspection.reduce(history, run: $0))
        }
        // RootTabs may disappear or be replaced while Gateway reads suspend.
        guard let presentation, presentation.id == rootID else {
            throw OpenClawNativeActionError("Open OpenClaw before running this action.")
        }
        self.accountBinding = binding
        try presentation.open(request, binding, receipt)
        // Selection commits inside the handler, after its modal admission guard.
        // Appearance cannot run on the main actor until this handler returns.
        self.inspectionPresentation = receipt
        self.presentedInspectionID = nil
        let selectionID = self.selectionID
        let presentationDeadline = clock.now.advanced(by: .seconds(10))
        while clock.now < presentationDeadline {
            guard await binding.isCurrent(), generation == self.appModel.gatewayConnectGeneration,
                  self.currentAccountAuthority == accountAuthority,
                  self.presentation?.id == presentation.id,
                  self.selectionID == selectionID else { throw CancellationError() }
            if let chat, let transport = self.chatTransport,
               transport.nativeBinding?.canReuse(binding) == true
            {
                let presented = PresentedChat(
                    gateway: captured.bindingGateway(binding),
                    binding: binding,
                    chat: chat,
                    transport: transport,
                    presentationID: presentation.id,
                    selectionID: selectionID,
                    accountAuthority: accountAuthority)
                if self.isCurrent(presented), receipt.map(self.isInspectionPresented) ?? true {
                    return presented
                }
                if let reason = chat.errorText {
                    throw OpenClawNativeActionError(reason)
                }
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw OpenClawNativeActionError("The selected chat is not ready. Open it and try again.")
    }

    private func requirePreservedDraft(
        _ session: OpenClawNativeSessionRef,
        binding: IOSNativeActionBinding? = nil) throws
    {
        if !self.appModel.chatPresentation.canPresentNativeSession(session, appModel: self.appModel, binding: binding) {
            throw OpenClawNativeActionError("Keep or send the current draft before opening a different session.")
        }
    }

    private func isCurrent(_ presented: PresentedChat) -> Bool {
        self.currentAccountAuthority == presented.accountAuthority &&
            self.presentation?.id == presented.presentationID &&
            self.selectionID == presented.selectionID &&
            self.chatPresentationID == presented.presentationID &&
            self.matches(presented.chat, session: presented.binding.session) &&
            self.chatTransport?.nativeBinding?.canReuse(presented.binding) == true &&
            !presented.chat.isLoading && presented.chat.healthOK && presented.chat.errorText == nil
    }

    private func matches(_ chat: OpenClawChatViewModel, session: OpenClawNativeSessionRef) -> Bool {
        self.chat === chat &&
            self.chatOwnerID == self.appModel.chatViewModelOwnerID &&
            self.appModel.chatTranscriptCacheGatewayID?.utf8.elementsEqual(session.owner.gatewayID.utf8) == true &&
            self.chatAgentID?.utf8.elementsEqual(session.agentID.utf8) == true &&
            self.appModel.chatDeliveryAgentId?.utf8.elementsEqual(session.agentID.utf8) == true &&
            self.appModel.chatSessionKey.utf8.elementsEqual(session.sessionKey.utf8) &&
            chat.currentSessionTarget.sessionKey.utf8.elementsEqual(session.sessionKey.utf8) &&
            (OpenClawChatSessionKey.agentID(from: chat.currentSessionTarget.sessionKey)
                ?? chat.currentSessionTarget.agentID)?.utf8.elementsEqual(session.agentID.utf8) == true
    }
}
