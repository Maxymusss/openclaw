import Foundation
import Observation
import OpenClawChatUI
import OpenClawProtocol

/// The view model owns its callback; the relay observes the adopted target
/// without retaining the view or closing a view-model reference cycle.
@MainActor
final class IOSChatSessionTargetRelay {
    weak var viewModel: OpenClawChatViewModel?
    let onChange: @MainActor (OpenClawChatViewModel) -> Void

    init(onChange: @escaping @MainActor (OpenClawChatViewModel) -> Void) {
        self.onChange = onChange
    }

    func sessionChanged() {
        guard let viewModel else { return }
        self.onChange(viewModel)
    }
}

@MainActor
@Observable
final class IOSChatViewModelOwner {
    private(set) var viewModel: OpenClawChatViewModel?
    private(set) var transport: IOSGatewayChatTransport?
    private(set) var ownerID = ""
    private(set) var presentationAgentID = "main"
    private(set) var presentationAgentName = "Main"
    private(set) var presentationAgentBadge = "M"
    private(set) var hasVerifiedOfflineRoutingIdentity = false
    private(set) var transportAgentID = ""
    private var routingContract = ""
    private var wasConnected = false
    @ObservationIgnored private var controlUIInputs: GatewayConnectConfig.ControlUIInputs?

    @ObservationIgnored private weak var nativeActions: NativeActionRouter?
    private var presentationID: UUID?

    struct TaskIdentity: Equatable {
        let route: String
        let sessionKey: String
        let routingContract: String?
        let isConnected: Bool
        let isRecording: Bool
        let isAttachmentOwnerPinned: Bool
        let hasProtectedComposer: Bool
        let newChatRequestID: Int
        let authority: GatewayConnectConfig.ControlUIInputs?
        let nativeBinding: ObjectIdentifier?
        let presentationID: UUID?
    }

    func taskIdentity(
        appModel: NodeAppModel,
        nativeBinding: IOSNativeActionBinding?,
        presentationID: UUID?) -> TaskIdentity
    {
        TaskIdentity(
            route: appModel.chatViewModelIdentityID,
            sessionKey: appModel.chatSessionKey,
            routingContract: appModel.chatSessionRoutingContract,
            isConnected: appModel.isOperatorGatewayConnected,
            isRecording: appModel.voiceNoteRecorder.ownsPendingChatAttachment,
            isAttachmentOwnerPinned: self.viewModel?.isAttachmentOwnerPinned == true,
            hasProtectedComposer: self.hasProtectedComposer(appModel: appModel),
            newChatRequestID: appModel.newChatRequestID,
            authority: appModel.activeGatewayConnectConfig?.controlUIInputs,
            nativeBinding: nativeBinding.map(ObjectIdentifier.init),
            presentationID: presentationID)
    }

    func synchronizePresentation(
        appModel: NodeAppModel,
        nativeBinding: IOSNativeActionBinding?,
        nativeActions: NativeActionRouter?,
        presentationID: UUID?) async
    {
        if nativeBinding == nil {
            await appModel.restoreChatSessionRoutingIdentityIfNeeded()
        }
        // A suspended ordinary restore cannot replace a newer native presentation.
        guard !Task.isCancelled else { return }
        self.sync(
            appModel: appModel, nativeBinding: nativeBinding,
            nativeActions: nativeActions, presentationID: presentationID)
        if self.matchesBinding(nativeBinding), let viewModel,
           appModel.consumeNewChatRequest(appModel.newChatRequestID)
        {
            _ = await viewModel.startNewSession()
        }
    }

    func sync(
        appModel: NodeAppModel,
        nativeBinding: IOSNativeActionBinding? = nil,
        nativeActions: NativeActionRouter? = nil,
        presentationID: UUID? = nil)
    {
        self.viewModel?.attachmentOwnerActivityChanged()
        let ownerID = appModel.chatViewModelOwnerID
        let agentID = nativeBinding?.session.agentID ?? Self.transportAgentID(appModel.chatDeliveryAgentId)
        let sessionKey = nativeBinding?.session.sessionKey ?? appModel.chatSessionKey
        let selectedRoutingContract = nativeBinding == nil
            ? appModel.chatSessionRoutingContract : nativeBinding?.sessionRoutingContract
        let routingContract = selectedRoutingContract ?? ""
        let bindingMatches = self.matchesBinding(nativeBinding)
        let connected = appModel.isOperatorGatewayConnected
        let controlUIInputs = appModel.activeGatewayConnectConfig?.controlUIInputs
        let authorityChanged = self.controlUIInputs != nil && controlUIInputs != nil &&
            self.controlUIInputs != controlUIInputs
        let reconnected = connected && !self.wasConnected
        self.wasConnected = connected
        if authorityChanged { self.viewModel?.retireQuestionAuthority() }
        if let viewModel, bindingMatches, !viewModel.isQuestionAuthorityRetired, !authorityChanged,
           !Self.requiresViewModelRebuild(
               currentOwnerID: self.ownerID,
               nextOwnerID: ownerID,
               currentTransportAgentID: self.transportAgentID,
               nextTransportAgentID: agentID)
        {
            if self.routingContract != routingContract {
                self.routingContract = routingContract
                viewModel.syncSessionRoutingContract(selectedRoutingContract)
            }
            self.nativeActions = nativeActions
            self.presentationID = presentationID
            viewModel.syncSession(to: sessionKey)
            if !viewModel.isAttachmentOwnerPinned {
                self.capturePresentationIdentity(appModel: appModel, nativeBinding: nativeBinding)
            }
            if let controlUIInputs { self.controlUIInputs = controlUIInputs }
            if reconnected { viewModel.refresh() }
            return
        }
        // Recording, staging, and delivery retain their captured route until the owner releases it.
        guard self.viewModel?.isAttachmentOwnerPinned != true else { return }
        let preservedInput: String?
        if let viewModel, let previous = self.transport?.nativeBinding, let nativeBinding,
           previous.canReopen(
               nativeBinding, preserving: viewModel,
               captureIsActive: appModel.isTalkCaptureActive ||
                   appModel.isChatDictationPending || appModel.isChatDictationActive)
        {
            // Reopening retains idle text only, never the retired transport or send authority.
            preservedInput = viewModel.input
        } else {
            if !bindingMatches, self.hasProtectedComposer(appModel: appModel) { return }
            preservedInput = nil
        }
        self.viewModel?.detachTransport()
        self.nativeActions = nativeActions
        self.presentationID = presentationID
        self.ownerID = ownerID
        self.transportAgentID = agentID
        self.routingContract = routingContract
        self.controlUIInputs = controlUIInputs
        self.capturePresentationIdentity(appModel: appModel, nativeBinding: nativeBinding)
        let offlineStore = nativeBinding == nil ? appModel.makeChatOfflineStore() : nil
        let voiceNoteRecorder = appModel.voiceNoteRecorder
        let agentName = self.presentationAgentName
        let agentBadge = self.presentationAgentBadge
        let transport = appModel.makeChatTransport(
            outboxGatewayID: offlineStore?.gatewayID, nativeBinding: nativeBinding)
        self.transport = transport as? IOSGatewayChatTransport
        let relay = IOSChatSessionTargetRelay { [weak self, weak appModel] viewModel in
            guard let self, self.viewModel === viewModel else { return }
            if let nativeBinding {
                self.nativeActions?.chatSessionChanged(
                    viewModel, binding: nativeBinding, presentationID: self.presentationID)
            } else {
                appModel?.focusChatSession(viewModel.currentSessionTarget)
            }
        }
        let viewModel = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: nativeBinding?.session.agentID ?? appModel.chatDeliveryAgentId,
            sessionRoutingContract: selectedRoutingContract,
            attachmentOwnerIsActive: { [weak voiceNoteRecorder] in
                voiceNoteRecorder?.ownsPendingChatAttachment == true
            },
            transcriptCache: offlineStore,
            outbox: offlineStore,
            onSessionChanged: { _ in relay.sessionChanged() },
            captureSessionTransitionAuthority: { [weak self, weak relay] in
                guard let nativeBinding else { return { true } }
                guard let self, let viewModel = relay?.viewModel, self.viewModel === viewModel,
                      let nativeActions = self.nativeActions else { return { false } }
                return nativeActions.captureSessionTransitionAuthority(
                    viewModel, binding: nativeBinding, presentationID: self.presentationID)
            },
            onToolActivity: { id, name, isActive, toolSessionKey in
                if isActive {
                    LiveActivityManager.shared.showTool(
                        id: id,
                        name: name,
                        agentName: agentName,
                        agentBadge: agentBadge,
                        sessionKey: toolSessionKey)
                } else {
                    LiveActivityManager.shared.endTool(id: id, sessionKey: toolSessionKey)
                }
            },
            diagnosticsLog: { message in GatewayDiagnostics.log(message) })
        relay.viewModel = viewModel
        self.viewModel = viewModel
        if let preservedInput { viewModel.input = preservedInput }
        viewModel.load()
    }

    func isCurrent(appModel: NodeAppModel) -> Bool {
        self.ownerID == appModel.chatViewModelOwnerID &&
            self.controlUIInputs == appModel.activeGatewayConnectConfig?.controlUIInputs
    }

    func hasProtectedComposer(appModel: NodeAppModel) -> Bool {
        appModel.voiceNoteRecorder.ownsPendingChatAttachment ||
            self.viewModel.map {
                !$0.input.isEmpty || $0.replyTarget != nil || $0.hasDraftToSend || $0.isAttachmentOwnerPinned
            } == true
    }

    private func matchesBinding(_ next: IOSNativeActionBinding?) -> Bool {
        switch (self.transport?.nativeBinding, next) {
        case (nil, nil): true
        case let (current?, next?): current.canReuse(next)
        default: false
        }
    }

    private func capturePresentationIdentity(appModel: NodeAppModel, nativeBinding: IOSNativeActionBinding?) {
        let agentID = nativeBinding?.session.agentID ??
            appModel.chatAgentId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.presentationAgentID = agentID.isEmpty ? "main" : agentID
        let agent = appModel.gatewayAgents.first { $0.id.utf8.elementsEqual(self.presentationAgentID.utf8) }
        let name = agent?.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let fallbackName = nativeBinding == nil ? appModel.chatAgentName : self.presentationAgentID
        self.presentationAgentName = name.isEmpty ? fallbackName : name
        self.presentationAgentBadge = AgentIdentityPresentation.normalizedBadgeEmoji(
            agent?.identity?["emoji"]?.value as? String) ??
            AgentIdentityPresentation.initialsBadge(for: self.presentationAgentName)
        self.hasVerifiedOfflineRoutingIdentity = nativeBinding == nil && appModel.hasVerifiedChatOfflineRoutingIdentity
    }

    nonisolated static func transportAgentID(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    nonisolated static func requiresViewModelRebuild(
        currentOwnerID: String,
        nextOwnerID: String,
        currentTransportAgentID: String,
        nextTransportAgentID: String) -> Bool
    {
        currentOwnerID != nextOwnerID || currentTransportAgentID != nextTransportAgentID
    }
}
