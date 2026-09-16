import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct NativeActionRouterTests {
    @MainActor
    private final class Host {
        let model: NodeAppModel
        let controller: GatewayConnectionController
        let router: NativeActionRouter
        let gatewayID = "native-target-\(UUID().uuidString)"
        var fixture: NativeGatewayWebSocketFixture?
        var presentationID: UUID?
        var chatRegistrationID: UUID?
        var binding: IOSNativeActionBinding?
        var receipt: NativeActionRouter.RunPresentation?
        var chat: OpenClawChatViewModel? {
            self.model.chatPresentation.viewModel
        }

        var sent: [[String: Any]] = []
        var createdSessions = 0
        var presentations = 0
        var ordinaryChat = false
        var retired = 0
        var rejectPresentation = false
        var registerPresentedChat = true
        var beforeInspectionHistory: (() -> Void)?
        var beforeResponse: ((String) -> Void)?
        var beforeSendReply: (() -> Void)?
        var deferredSendReply: (@MainActor @Sendable () async -> Void)?
        var profileID = "alice"
        var catalogDiscovery = false
        var rejectMethod: String?
        var rejectionExecution = "not_started"
        var requestsBeforeRejection = 0
        var widgetRefreshes = 0
        var rosterRequests = 0
        var issuedRunIDs: Set<String> = []
        var callbackViolations: [String] = []
        var callbackViolationCount = 0

        func observeCallback(_ condition: Bool, rule: String, method: String) {
            guard !condition else { return }
            self.callbackViolationCount += 1
            if self.callbackViolations.count < 16 {
                self.callbackViolations.append("method=\(method) rule=\(rule)")
            }
        }

        init() {
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            self.model = model
            let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
            self.controller = controller
            self.router = NativeActionRouter(appModel: model, gatewayController: controller)
            self.presentationID = self.router.registerPresentation(onRetire: { [weak self] in
                self?.retired += 1
                self?.binding = nil
                self?.receipt = nil
            }) { [weak self] request, binding, receipt in
                guard let self, !self.rejectPresentation else { throw CancellationError() }
                self.presentations += 1
                self.model.setSelectedAgentId(request.session.agentID)
                self.model.focusChatSession(request.session.sessionKey)
                self.receipt = receipt
                let owner = self.model.chatPresentation
                owner.sync(
                    appModel: self.model, nativeBinding: binding,
                    nativeActions: self.router, presentationID: self.presentationID)
                self.binding = binding
                if self.registerPresentedChat, let chat = owner.viewModel, let transport = owner.transport,
                   transport.nativeBinding?.canReuse(binding) == true
                {
                    self.chatRegistrationID = self.router.registerChat(
                        chat, ownerID: owner.ownerID, agentID: owner.transportAgentID,
                        transport: transport, presentationID: self.presentationID)
                }
            }
        }

        func session(_ agent: String = "main") -> OpenClawNativeSessionRef {
            .init(owner: .init(gatewayID: self.gatewayID, profileID: "alice"), agentID: agent, sessionKey: "global")
        }

        func connect() async throws {
            let fixture = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                hello: .init(role: "operator", scopes: ["operator.read", "operator.write"], capabilities: [
                    GatewayServerCapability.profileBinding.rawValue,
                    GatewayServerCapability.chatSendRoutingContract.rawValue,
                    GatewayServerCapability.sessionSettingsCAS.rawValue,
                ]),
                rpcHandler: { [weak self] request in
                    guard let self else { return .failure(code: "UNAVAILABLE", message: "Fixture closed") }
                    let params = request["params"] as? [String: Any] ?? [:]
                    let methodLabel: String = switch request["method"] as? String {
                    case let method? where [
                        "users.self",
                        "plugin.surface.refresh",
                        "agents.list",
                        "chat.history",
                        "sessions.messages.subscribe",
                        "health",
                        "sessions.list",
                        "chat.send",
                        "agent.wait",
                        "models.list",
                        "commands.list",
                        "chat.metadata",
                        "tasks.list",
                    ]
                        .contains(method): method
                    default: "unknown"
                    }
                    if request["method"] as? String == "sessions.list", params["limit"] as? Int == 80 {
                        // Agent selection also refreshes the ordinary UI share route.
                        self.observeCallback(
                            request["expectedProfileId"] == nil,
                            rule: "share-profile",
                            method: methodLabel)
                        self.observeCallback(
                            Set(params.keys) == ["limit", "includeGlobal", "includeUnknown", "agentId"],
                            rule: "share-shape",
                            method: methodLabel)
                        self.observeCallback(
                            params["includeGlobal"] as? Bool == true,
                            rule: "share-global",
                            method: methodLabel)
                        self.observeCallback(
                            params["includeUnknown"] as? Bool == false,
                            rule: "share-unknown",
                            method: methodLabel)
                        self.observeCallback(
                            ["main", "research"].contains(params["agentId"] as? String ?? ""),
                            rule: "share-agent",
                            method: methodLabel)
                    } else if self.ordinaryChat {
                        // Only ordinary-owner tests bootstrap without a captured profile.
                        // Native fixtures retain the exact profile assertion below.
                        self.observeCallback([
                            "agents.list", "chat.history", "sessions.messages.subscribe", "health",
                            "sessions.list", "models.list", "commands.list", "chat.metadata", "tasks.list",
                        ].contains(methodLabel), rule: "ordinary-read-method", method: methodLabel)
                        self.observeCallback(
                            request["expectedProfileId"] == nil, rule: "ordinary-profile", method: methodLabel)
                    } else {
                        let isCatalog = self.catalogDiscovery && (
                            request["method"] as? String == "users.self" ||
                                (request["method"] as? String == "sessions.list" && params["limit"] as? Int == 50))
                        let expected = isCatalog ? (request["method"] as? String == "users.self" ? nil : self.profileID)
                            : "alice"
                        self.observeCallback(
                            request["expectedProfileId"] as? String == expected,
                            rule: "selected-profile",
                            method: methodLabel)
                    }
                    if request["method"] as? String == "chat.send" { self.sent.append(params) }
                    if request["method"] as? String == "sessions.create" { self.createdSessions += 1 }
                    if request["method"] as? String == self.rejectMethod {
                        if self.requestsBeforeRejection == 0 {
                            self.rejectMethod = nil
                            return .failure(code: "INVALID_REQUEST", message: "Selected profile changed", details: [
                                "reason": "EXPECTED_PROFILE_MISMATCH", "execution": self.rejectionExecution,
                            ])
                        }
                        self.requestsBeforeRejection -= 1
                    }
                    self.beforeResponse?(request["method"] as? String ?? "")
                    switch request["method"] as? String {
                    case "users.self": return .success(["profile": ["id": self.profileID]])
                    case "plugin.surface.refresh":
                        self.widgetRefreshes += 1
                        return .success(["pluginSurfaceUrls": [
                            "canvas": "http://native-widget.invalid/__openclaw__/cap/fixture",
                        ]])
                    case "agents.list":
                        self.rosterRequests += 1
                        return .success([
                            "defaultId": "main", "mainKey": "main", "scope": "per-sender",
                            "agents": [["id": "main"], ["id": "research"]],
                        ])
                    case "chat.history":
                        if params["inputRunIds"] != nil {
                            let before = self.beforeInspectionHistory
                            self.beforeInspectionHistory = nil
                            before?()
                        }
                        let key = params["sessionKey"] as? String ?? ""
                        let agent = params["agentId"] as? String ?? OpenClawChatSessionKey.agentID(from: key) ?? "main"
                        return .success([
                            "sessionKey": key, "messages": [],
                            "sessionInfo": [
                                "key": key, "agentId": agent, "sessionId": "session-\(agent)",
                                "permissionMode": "guarded", "toolOverrides": [:],
                                "activeRunIds": params["inputRunIds"] as? [String] ?? [],
                            ],
                        ])
                    case "sessions.messages.subscribe":
                        return .success(["subscribed": true, "key": params["key"] as? String ?? ""])
                    case "health": return .success(["ok": true])
                    case "sessions.list": return .success([
                            "ts": 0, "count": 2, "sessions": ["main", "research"].map {
                                ["key": "global", "agentId": $0, "permissionMode": "guarded", "toolOverrides": [:]]
                            },
                        ])
                    case "chat.send":
                        let before = self.beforeSendReply
                        self.beforeSendReply = nil
                        before?()
                        let runID = "run-\(self.sent.count)"
                        self.issuedRunIDs.insert(runID)
                        if let deferred = self.deferredSendReply {
                            self.deferredSendReply = nil
                            return .deferred {
                                await deferred()
                                return .success(["runId": runID, "status": "ok"])
                            }
                        }
                        return .success(["runId": runID, "status": "ok"])
                    case "agent.wait":
                        // An accepted send can arm its waiter before terminal-ACK reconciliation.
                        // Only IDs actually issued by this fixture have a completed run to inspect.
                        let valid = Set(params.keys) == ["runId", "timeoutMs"] &&
                            self.issuedRunIDs.contains(params["runId"] as? String ?? "") &&
                            (params["timeoutMs"] as? Int ?? 0) > 0
                        self.observeCallback(valid, rule: "issued-run-wait", method: methodLabel)
                        guard valid else { return .failure(code: "INVALID_REQUEST", message: "Invalid fixture wait") }
                        return .success(["status": "ok"])
                    case "models.list", "commands.list": return .success([
                            request["method"] as? String == "models.list" ? "models" : "commands": [],
                        ])
                    case "chat.metadata": return .success(["swarmEnabled": false])
                    case "tasks.list": return .success(["tasks": []])
                    default:
                        self.observeCallback(false, rule: "unexpected-method", method: methodLabel)
                        return .failure(code: "INVALID_REQUEST", message: "Unexpected fixture method")
                    }
                })
            self.fixture = fixture
            var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
            options.allowStoredDeviceAuth = false
            options.deviceAuthGatewayID = self.gatewayID
            try await self.model.operatorSession.connect(
                url: fixture.url(), credentials: .init(), connectOptions: options, sessionBox: nil,
                onConnected: {}, onDisconnected: { _ in }, onInvoke: { .init(id: $0.id, ok: true) })
            self.model.activeGatewayConnectConfig = GatewayConnectConfig(
                url: fixture.url(), stableID: self.gatewayID, tls: nil, token: nil,
                bootstrapToken: nil, password: nil, nodeOptions: options)
            self.model.connectedGatewayID = self.gatewayID
            self.model.setOperatorConnected(true)
        }

        func prepare(_ agent: String = "main") async throws -> OpenClawNativePreparedSend {
            try await self.router.prepareSend(to: self.session(agent), message: "one intentional message")
        }

        func openOrdinaryChat() async throws -> OpenClawChatViewModel {
            self.ordinaryChat = true
            self.model.setSelectedAgentId("main")
            self.model.focusChatSession("global")
            let owner = self.model.chatPresentation
            owner.sync(appModel: self.model)
            let chat = try #require(owner.viewModel)
            let transport = try #require(owner.transport)
            self.chatRegistrationID = self.router.registerChat(
                chat, ownerID: owner.ownerID, agentID: owner.transportAgentID,
                transport: transport, presentationID: self.presentationID)
            let deadline = ContinuousClock.now + .seconds(2)
            while chat.isLoading, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(!chat.isLoading)
            #expect(chat.healthOK)
            #expect(chat.errorText == nil)
            return chat
        }

        func hideChat() throws {
            try self.router.unregisterChat(#require(self.chatRegistrationID))
            self.chatRegistrationID = nil
        }

        func waitForReceipt() async throws -> NativeActionRouter.RunPresentation {
            let deadline = ContinuousClock.now + .seconds(2)
            while self.receipt == nil, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            return try #require(self.receipt)
        }

        func close() async {
            self.beforeInspectionHistory = nil
            self.beforeResponse = nil
            self.beforeSendReply = nil
            self.deferredSendReply = nil
            if let presentationID { self.router.unregisterPresentation(presentationID) }
            self.chat?.detachTransport()
            await self.model.operatorSession.disconnect()
            await self.fixture?.stopAndWait()
            self.model.activeGatewayConnectConfig = nil
            self.model.voiceWake.stop()
            await self.model.purgeChatTranscriptCache(gatewayID: self.gatewayID)
        }
    }

    private func withHost(_ run: (Host) async throws -> Void) async throws {
        try await withUserDefaults([
            "talk.enabled": false, "talk.background.enabled": false, VoiceWakePreferences.enabledKey: false,
        ]) {
            let host = Host()
            let outcome: Result<Void, Error>
            do {
                try await host.connect()
                try await run(host)
                outcome = .success(())
            } catch {
                outcome = .failure(error)
            }
            await host.close()
            // NW callbacks do not carry Swift Testing's originating task context.
            // Close admission and join their writers before reporting any violations here.
            #expect(
                host.callbackViolationCount == 0,
                "count=\(host.callbackViolationCount) overflow=\(host.callbackViolationCount > 16) \(host.callbackViolations.joined(separator: " | "))")
            try outcome.get()
        }
    }

    @Test(arguments: [false, true])
    func `hidden retained drafts refuse another agent before changing selection`(native: Bool) async throws {
        try await self.withHost { host in
            let chat: OpenClawChatViewModel
            if native {
                #expect(await host.router.open(.session(host.session())) == .opened)
                chat = try #require(host.chat)
            } else {
                chat = try await host.openOrdinaryChat()
            }
            let owner = host.model.chatPresentation
            let binding = owner.transport?.nativeBinding
            let target = chat.currentSessionTarget
            chat.input = "Keep this hidden draft"
            try host.hideChat()
            owner.sync(appModel: host.model)
            let retired = host.retired
            let presentations = host.presentations
            let config = host.model.activeGatewayConnectConfig?.controlUIInputs
            let route = await host.model.operatorSession.currentRoute()

            #expect(await host.router.open(.session(host.session("research"))) == .unavailable(
                reason: "Keep or send the current draft before opening a different session."))
            #expect(owner.viewModel === chat)
            #expect(owner.transport?.nativeBinding === binding)
            #expect(chat.currentSessionTarget == target)
            #expect(chat.input == "Keep this hidden draft")
            #expect(!chat.isQuestionAuthorityRetired)
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.model.activeGatewayConnectConfig?.controlUIInputs == config)
            #expect(await host.model.operatorSession.currentRoute() == route)
            #expect(host.chatRegistrationID == nil)
            #expect(host.binding == nil)
            #expect(host.presentations == presentations)
            #expect(host.retired == retired)
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test func `hidden ordinary draft refuses replacement by a native binding on the same target`() async throws {
        try await self.withHost { host in
            let chat = try await host.openOrdinaryChat()
            chat.input = "Ordinary composer draft"
            try host.hideChat()
            host.model.chatPresentation.sync(appModel: host.model)
            #expect(await host.router.open(.session(host.session())) == .unavailable(
                reason: "Keep or send the current draft before opening a different session."))
            #expect(host.model.chatPresentation.viewModel === chat)
            #expect(host.model.chatPresentation.transport?.nativeBinding == nil)
            #expect(chat.input == "Ordinary composer draft")
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.presentations == 0)
            #expect(host.chatRegistrationID == nil)
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test func `hidden ordinary draft refuses a saved Gateway before persisting a switch`() async throws {
        try await self.withHost { host in
            let chat = try await host.openOrdinaryChat()
            chat.input = "Stay with the original Gateway"
            try host.hideChat()
            host.model.chatPresentation.sync(appModel: host.model)
            let isolation = GatewayRegistryTestIsolation()
            defer { isolation.restore() }
            let otherGateway = "manual|127.0.0.1|2"
            #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
                stableID: otherGateway, kind: .manual, name: "Other test Gateway",
                host: "127.0.0.1", port: 2, useTLS: false, lastConnectedAtMs: nil)))
            let registry = GatewaySettingsStore.loadGatewayRegistry()
            let config = host.model.activeGatewayConnectConfig?.controlUIInputs
            let route = await host.model.operatorSession.currentRoute()
            let generation = host.model.gatewayConnectGeneration
            let target = OpenClawNativeSessionRef(
                owner: .init(gatewayID: otherGateway, profileID: "alice"),
                agentID: "main", sessionKey: "global")

            #expect(await host.router.open(.session(target)) == .unavailable(
                reason: "Keep or send the current draft before opening a different session."))
            #expect(GatewaySettingsStore.loadGatewayRegistry() == registry)
            #expect(host.model.activeGatewayConnectConfig?.controlUIInputs == config)
            #expect(await host.model.operatorSession.currentRoute() == route)
            #expect(host.model.gatewayConnectGeneration == generation)
            #expect(host.model.chatPresentation.viewModel === chat)
            #expect(host.model.chatPresentation.transport?.nativeBinding == nil)
            #expect(chat.input == "Stay with the original Gateway")
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.presentations == 0)
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test func `draft arriving in a hidden owner during history refuses the verified replacement`() async throws {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let owner = host.model.chatPresentation
            let chat = try #require(owner.viewModel)
            let binding = try #require(owner.transport?.nativeBinding)
            let target = chat.currentSessionTarget
            try host.hideChat()
            let presentations = host.presentations
            host.beforeResponse = { method in
                guard method == "chat.history" else { return }
                host.beforeResponse = nil
                chat.input = "Draft typed while history was loading"
                owner.sync(appModel: host.model)
            }

            #expect(await host.router.open(.session(host.session("research"))) == .unavailable(
                reason: "Keep or send the current draft before opening a different session."))
            #expect(host.beforeResponse == nil)
            #expect(owner.viewModel === chat)
            #expect(owner.transport?.nativeBinding === binding)
            #expect(chat.currentSessionTarget == target)
            #expect(chat.input == "Draft typed while history was loading")
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.presentations == presentations)
            #expect(host.chatRegistrationID == nil)
            #expect(host.binding == nil)
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test(arguments: ["text", "attachment", "capture"])
    func `retained native composer refuses replacement and reuses the same target`(
        composer: String) async throws
    {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let chat = try #require(host.chat)
            let binding = try #require(host.binding)
            if composer == "text" { chat.input = "Keep the same composer" }
            if composer == "attachment" {
                chat.attachments = [.init(
                    url: nil, data: Data("fixture".utf8), fileName: "fixture.txt", mimeType: "text/plain",
                    preview: nil)]
            }
            if composer == "capture" { host.model.acquirePttVoiceWakeLease(for: "native-draft-test") }
            defer { host.model.releasePttVoiceWakeLease(for: "native-draft-test") }
            let attachments = chat.attachments.map(\.id)
            try host.hideChat()
            // Text and attachments survive RootTabs' ordinary synchronization too.
            // Capture admission is checked in the interval before that task runs.
            if composer != "capture" { host.model.chatPresentation.sync(appModel: host.model) }

            #expect(await host.router.open(.session(host.session("research"))) == .unavailable(
                reason: "Keep or send the current draft before opening a different session."))
            #expect(await host.router.open(.session(host.session())) == .opened)
            #expect(host.chat === chat)
            #expect(host.model.chatPresentation.transport?.nativeBinding === binding)
            #expect(host.binding?.canReuse(binding) == true)
            #expect(chat.input == (composer == "text" ? "Keep the same composer" : ""))
            #expect(chat.attachments.map(\.id) == attachments)
            #expect(host.chatRegistrationID != nil)
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test func `native admission protects an unregistered send until its reply joins`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let chat = try #require(host.chat)
            let reply = AsyncStream<Void>.makeStream()
            host.deferredSendReply = {
                for await _ in reply.stream {
                    return
                }
            }
            let send = Task { try await prepared.submit() }
            do {
                let deadline = ContinuousClock.now + .seconds(2)
                while host.sent.isEmpty, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(host.sent.count == 1)
                #expect(chat.input.isEmpty)
                #expect(!chat.canPreserveIdleTextDraft)
                // Exercise native admission before RootTabs' ordinary sync task;
                // unregister alone does not settle or transfer this accepted send.
                try host.hideChat()
                let presentations = host.presentations
                #expect(await host.router.open(.session(host.session("research"))) == .unavailable(
                    reason: "Keep or send the current draft before opening a different session."))
                #expect(host.chat === chat)
                #expect(host.model.chatDeliveryAgentId == "main")
                #expect(host.model.chatSessionKey == "global")
                #expect(host.presentations == presentations)
                reply.continuation.finish()
                #expect(try await send.value.runID == "run-1")
                #expect(host.sent.count == 1)
                #expect(host.createdSessions == 0)
            } catch {
                reply.continuation.finish()
                _ = try? await send.value
                throw error
            }
        }
    }

    @Test(arguments: [false, true])
    func `native account replacement retires questions even when composer adoption is refused`(
        restoresOriginalAccount: Bool) async throws
    {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let owner = host.model.chatPresentation
            let chat = try #require(owner.viewModel)
            let binding = try #require(owner.transport?.nativeBinding)
            let original = try #require(host.model.activeGatewayConnectConfig)
            let target = chat.currentSessionTarget
            let attachment = OpenClawPendingAttachment(
                url: nil, data: Data("fixture".utf8), fileName: "fixture.txt", mimeType: "text/plain", preview: nil)
            chat.attachments = [attachment]
            chat.input = "Keep this native draft with its attachment"
            chat.upsertQuestion(QuestionRecord(
                id: "native-account-question",
                questions: [Question(
                    questionid: "choice", header: "Choice", question: "Choose the deployment target",
                    options: [QuestionOption(label: "Staging")])],
                createdatms: 1, expiresatms: Int.max, status: .pending))
            host.model.activeGatewayConnectConfig = GatewayConnectConfig(
                url: original.url, stableID: original.stableID, tls: original.tls,
                token: "synthetic-replacement", bootstrapToken: original.bootstrapToken,
                password: original.password, nodeOptions: original.nodeOptions)

            #expect(!owner.canPresentNativeSession(binding.session, appModel: host.model, binding: binding))
            #expect(!chat.isQuestionAuthorityRetired)
            #expect(chat.questionCards.map(\.id) == ["native-account-question"])
            owner.sync(
                appModel: host.model, nativeBinding: binding,
                nativeActions: host.router, presentationID: host.presentationID)
            #expect(chat.isQuestionAuthorityRetired)
            #expect(chat.questionCards.isEmpty)
            #expect(owner.viewModel === chat)
            #expect(owner.transport?.nativeBinding === binding)
            #expect(chat.currentSessionTarget == target)
            #expect(chat.input == "Keep this native draft with its attachment")
            #expect(chat.attachments.map(\.id) == [attachment.id])
            if restoresOriginalAccount {
                host.model.activeGatewayConnectConfig = original
                owner.sync(
                    appModel: host.model, nativeBinding: binding,
                    nativeActions: host.router, presentationID: host.presentationID)
                #expect(owner.viewModel === chat)
                #expect(chat.isQuestionAuthorityRetired)
                #expect(chat.questionCards.isEmpty)
                #expect(chat.input == "Keep this native draft with its attachment")
                #expect(chat.attachments.map(\.id) == [attachment.id])
            }
            chat.removeAttachment(attachment.id)
            #expect(!chat.isAttachmentOwnerPinned)
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.sent.isEmpty)
            #expect(host.createdSessions == 0)
        }
    }

    @Test(arguments: ["open owner", "open history", "prepare owner", "confirmation", "catalog"])
    func `captured owner observations retire cached authority without a broadcast`(stage: String) async throws {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let original = try #require(host.binding)
            let sibling = try await IOSNativeActionBinding.capture(
                session: original.session, gateway: original.gateway, route: original.route,
                reservation: original.reserveRetirement())
            let transport = IOSGatewayChatTransport(gateway: original.gateway, nativeBinding: original)
            let scoped = try #require(transport.scoped(toAgentID: "research") as? IOSGatewayChatTransport)
            let path = "/__openclaw__/canvas/documents/test/index.html"
            #expect(await transport.resolveInlineWidgetResource(path: path, replacing: nil) != nil)
            #expect(host.widgetRefreshes == 1)
            let prepared = stage == "confirmation" ? try await host.prepare() : nil
            if stage == "catalog" {
                host.catalogDiscovery = true
                host.profileID = "bob"
                let choices = try await host.router.sessions(matching: nil)
                #expect(!choices.isEmpty)
                #expect(choices.allSatisfy { $0.session.owner.profileID == "bob" })
            } else {
                host.rejectMethod = stage == "open history" ? "chat.history" : "users.self"
                host.requestsBeforeRejection = stage == "prepare owner" ? 1 : 0
                if stage == "open owner" || stage == "open history" {
                    guard case .unavailable = await host.router.open(.session(host.session())) else {
                        Issue.record("The captured verification must report the refused owner")
                        return
                    }
                } else {
                    do {
                        if let prepared { _ = try await prepared.submit() } else { _ = try await host.prepare() }
                        Issue.record("The owner refusal must prevent preparation or confirmation")
                    } catch let error as GatewayResponseError {
                        #expect(error.detailsReason == "EXPECTED_PROFILE_MISMATCH")
                        #expect(error.details["execution"]?.stringValue == "not_started")
                    }
                }
                #expect(host.rejectMethod == nil)
            }
            #expect(await original.gateway.currentRoute() == original.route)
            #expect(await original.isCurrent() == false)
            #expect(await sibling.isCurrent() == false)
            #expect(await transport.resolveInlineWidgetResource(path: path, replacing: nil) == nil)
            #expect(await scoped.resolveInlineWidgetResource(path: path, replacing: nil) == nil)
            #expect(host.widgetRefreshes == 1)
            #expect(host.sent.isEmpty)
        }
    }

    @Test(arguments: [false, true])
    func `retained confirmations retire a different session's warm account authority`(
        unregister: Bool) async throws
    {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let original = try #require(host.binding)
            let originalChat = try #require(host.chat)
            if unregister {
                host.router.unregisterChat(host.chatRegistrationID)
                originalChat.detachTransport()
            }
            #expect(await host.router.open(.session(host.session("research"))) == .opened)
            let current = try #require(host.binding)
            #expect(host.chat !== originalChat)
            #expect(original.session != current.session)
            #expect(!original.canReuse(current))
            let transport = IOSGatewayChatTransport(gateway: current.gateway, nativeBinding: current)
            let scoped = try #require(transport.scoped(toAgentID: "main") as? IOSGatewayChatTransport)
            let path = "/__openclaw__/canvas/documents/test/index.html"
            let warm = try #require(await transport.resolveInlineWidgetResource(path: path, replacing: nil))
            #expect(host.widgetRefreshes == 1)

            host.rejectMethod = "users.self"
            do {
                _ = try await prepared.submit()
                Issue.record("The retained confirmation must preserve its account refusal")
            } catch let error as GatewayResponseError {
                #expect(error.detailsReason == "EXPECTED_PROFILE_MISMATCH")
                #expect(error.details["execution"]?.stringValue == "not_started")
            }
            #expect(host.rejectMethod == nil)
            #expect(await original.gateway.currentRoute() == original.route)
            #expect(await original.isCurrent() == false)
            #expect(await current.isCurrent() == false)
            #expect(await transport.resolveInlineWidgetResource(path: path, replacing: nil) == nil)
            #expect(await scoped.resolveInlineWidgetResource(path: path, replacing: nil) == nil)
            #expect(host.widgetRefreshes == 1)

            #expect(await host.router.open(.session(host.session("research"))) == .opened)
            let fresh = try #require(host.binding)
            #expect(fresh.profileObservationID != current.profileObservationID)
            #expect(await fresh.isCurrent())
            host.rejectMethod = "users.self"
            do {
                _ = try await prepared.submit()
                Issue.record("The old confirmation must remain refused after a fresh capture")
            } catch let error as GatewayResponseError {
                #expect(error.detailsReason == "EXPECTED_PROFILE_MISMATCH")
                #expect(error.details["execution"]?.stringValue == "not_started")
            }
            #expect(host.rejectMethod == nil)
            #expect(await fresh.isCurrent())
            let freshTransport = IOSGatewayChatTransport(gateway: fresh.gateway, nativeBinding: fresh)
            #expect(await freshTransport.resolveInlineWidgetResource(path: path, replacing: nil)?.url == warm.url)
            #expect(host.widgetRefreshes == 1)
            #expect(host.sent.isEmpty)
        }
    }

    @Test(arguments: ["users.self", "chat.history"])
    func `retirement during initial verification cannot admit a fresh account lifetime`(method: String) async throws {
        try await self.withHost { host in
            #expect(await host.router.open(.session(host.session())) == .opened)
            let original = try #require(host.binding)
            let originalChat = try #require(host.chat)
            let rosterRequests = host.rosterRequests
            let retired = host.retired
            host.beforeResponse = { received in
                guard received == method else { return }
                host.beforeResponse = nil
                original.observe(.rejected(expectedProfileID: original.expectedProfileId))
            }

            let outcome = await host.router.open(.session(host.session("research")))
            #expect(outcome == .unavailable(
                reason: GatewayNodeSessionRequestError.routeChangedBeforeDispatch.localizedDescription))
            #expect(host.beforeResponse == nil)
            #expect(await original.isCurrent() == false)
            #expect(await original.gateway.currentRoute() == original.route)
            #expect(host.binding === original)
            #expect(host.chat === originalChat)
            #expect(host.model.chatDeliveryAgentId == "main")
            #expect(host.retired == retired)
            #expect(host.rosterRequests == rosterRequests)

            #expect(await host.router.open(.session(host.session("research"))) == .opened)
            let fresh = try #require(host.binding)
            #expect(fresh.session == host.session("research"))
            #expect(fresh.profileObservationID != original.profileObservationID)
            #expect(await fresh.isCurrent())
            #expect(host.rosterRequests == rosterRequests + 1)
            #expect(host.sent.isEmpty)
        }
    }

    @Test(arguments: ["first preparation", "first confirmation", "reopened confirmation"])
    func `new presentations observe their own subsequent account refusals`(stage: String) async throws {
        try await self.withHost { host in
            let prepared: OpenClawNativePreparedSend?
            if stage == "first preparation" {
                host.requestsBeforeRejection = 1
                prepared = nil
            } else {
                if stage == "reopened confirmation" {
                    _ = try await host.prepare()
                    let original = try #require(host.binding)
                    original.observe(.verified(profileID: "bob"))
                    #expect(await original.isCurrent() == false)
                }
                prepared = try await host.prepare()
                let binding = try #require(host.binding)
                #expect(await binding.isCurrent())
                let transport = IOSGatewayChatTransport(gateway: binding.gateway, nativeBinding: binding)
                #expect(await transport.resolveInlineWidgetResource(
                    path: "/__openclaw__/canvas/documents/test/index.html", replacing: nil) != nil)
            }
            host.rejectMethod = "users.self"
            do {
                if let prepared { _ = try await prepared.submit() } else { _ = try await host.prepare() }
                Issue.record("The new presentation must preserve its owner's typed refusal")
            } catch let error as GatewayResponseError {
                #expect(error.detailsReason == "EXPECTED_PROFILE_MISMATCH")
                #expect(error.details["execution"]?.stringValue == "not_started")
            }
            #expect(host.rejectMethod == nil)
            let binding = try #require(host.binding)
            #expect(await binding.isCurrent() == false)
            let transport = IOSGatewayChatTransport(gateway: binding.gateway, nativeBinding: binding)
            let refreshes = host.widgetRefreshes
            #expect(await transport.resolveInlineWidgetResource(
                path: "/__openclaw__/canvas/documents/test/index.html", replacing: nil) == nil)
            #expect(host.widgetRefreshes == refreshes)
            #expect(host.sent.isEmpty)
        }
    }

    @Test func `same-key agent navigation retires old confirmations even after returning`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let chat = try #require(host.chat)
            let unchanged = host.retired
            host.model.focusChatSession(chat.currentSessionTarget)
            #expect(host.retired == unchanged)
            chat.switchSession(to: "global", agentID: "research")
            #expect(host.model.chatDeliveryAgentId == "research")
            #expect(host.binding == nil)
            chat.switchSession(to: "global", agentID: "main")
            #expect(host.model.chatDeliveryAgentId == "main")
            await #expect(throws: Error.self) { _ = try await prepared.submit() }
            #expect(host.sent.isEmpty)
            let fresh = try await host.prepare()
            #expect(try await fresh.submit().session == host.session())
            #expect(host.sent.count == 1)
        }
    }

    @Test func `old model callbacks cannot retire a successor and modal rejection preserves selection`() async throws {
        try await self.withHost { host in
            _ = try await host.prepare()
            let oldChat = try #require(host.chat)
            let research = try await host.prepare("research")
            let current = try #require(host.binding)
            let retired = host.retired
            oldChat.switchSession(to: "agent:main:old-callback")
            #expect(host.model.chatSessionKey == "global")
            #expect(host.model.chatDeliveryAgentId == "research")
            #expect(host.binding?.canReuse(current) == true)
            #expect(host.retired == retired)
            host.rejectPresentation = true
            #expect(await host.router.open(.session(host.session())) == .cancelled)
            #expect(host.model.chatDeliveryAgentId == "research")
            host.rejectPresentation = false
            #expect(try await research.submit().session == host.session("research"))
            #expect(host.sent.count == 1)
            #expect(host.sent.first?["agentId"] as? String == "research")
        }
    }

    @Test(arguments: [false, true])
    func `confirmation exposes the captured message that submission retains`(long: Bool) async throws {
        try await self.withHost { host in
            let message = " \tFirst e\u{301} 🦊\n" +
                (long ? String(repeating: "A longer captured line e\u{301}\n", count: 300) : "Second line\n")
            let prepared = try await host.router.prepareSend(to: host.session(), message: message)
            #expect(prepared.message.utf8.elementsEqual(message.utf8))
            #expect(host.sent.isEmpty)
            let chat = try #require(host.chat)
            chat.input = "A different composer draft"
            let run = try await prepared.submit()
            #expect(run.session == host.session())
            #expect(host.sent.count == 1)
            let sent = try #require(host.sent.first?["message"] as? String)
            #expect(sent.utf8.elementsEqual(message.trimmingCharacters(in: .whitespacesAndNewlines).utf8))
            #expect(prepared.message.utf8.elementsEqual(message.utf8))
            #expect(chat.input == "A different composer draft")
        }
    }

    @Test(arguments: [false, true])
    func `presentation retirement clears host state in either view teardown order`(childFirst: Bool) async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let registrationID = try #require(host.chatRegistrationID)
            let binding = try #require(host.binding)
            let presentationID = try #require(host.presentationID)
            if childFirst { host.router.unregisterChat(registrationID) }
            host.router.unregisterPresentation(presentationID)
            if !childFirst { host.router.unregisterChat(registrationID) }
            #expect(host.binding == nil)
            #expect(host.receipt == nil)
            #expect(await binding.isCurrent())
            do {
                _ = try await prepared.submit()
                Issue.record("The retired presentation must reject its retained confirmation")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message == "The action route changed. Select the session again.")
            }
            #expect(host.sent.isEmpty)
        }
    }

    @Test(arguments: [false, true])
    func `stale visible chat registration cannot retire a successor on the same model`(native: Bool) async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let chat = try #require(host.chat)
            let binding = try #require(host.binding)
            let transport = IOSGatewayChatTransport(
                gateway: host.model.operatorSession, nativeBinding: native ? binding : nil)
            let original = try #require(host.router.registerChat(
                chat, ownerID: host.model.chatViewModelOwnerID, agentID: host.session().agentID,
                transport: transport, presentationID: host.presentationID))
            let successor = try #require(host.router.registerChat(
                chat, ownerID: host.model.chatViewModelOwnerID, agentID: host.session().agentID,
                transport: transport, presentationID: host.presentationID))
            #expect(original != successor)
            let retired = host.retired
            host.router.unregisterChat(original)
            #expect(host.retired == retired)
            #expect(host.binding === binding)
            if native {
                #expect(try await prepared.submit().session == host.session())
                #expect(host.sent.count == 1)
            }
            host.router.unregisterChat(successor)
            #expect(host.retired == retired + 1)
            #expect(host.binding == nil)
            host.router.unregisterChat(successor)
            #expect(host.retired == retired + 1)
        }
    }

    @Test func `session transition authority cannot revive when the same retained chat registers again`() async throws {
        try await self.withHost { host in
            _ = try await host.prepare()
            let chat = try #require(host.chat)
            let binding = try #require(host.binding)
            let presentationID = try #require(host.presentationID)
            let transport = IOSGatewayChatTransport(gateway: host.model.operatorSession, nativeBinding: binding)
            let target = chat.currentSessionTarget
            let captured = host.router.captureSessionTransitionAuthority(
                chat, binding: binding, presentationID: presentationID)
            #expect(captured())
            host.router.unregisterChat(host.chatRegistrationID)
            #expect(!captured())
            host.chatRegistrationID = host.router.registerChat(
                chat, ownerID: host.model.chatViewModelOwnerID, agentID: host.session().agentID,
                transport: transport, presentationID: presentationID)
            #expect(chat.currentSessionTarget == target)
            #expect(await binding.isCurrent())
            #expect(!captured())
            let reopened = host.router.captureSessionTransitionAuthority(
                chat, binding: binding, presentationID: presentationID)
            #expect(reopened())
            host.router.unregisterPresentation(presentationID)
            #expect(!reopened())
            #expect(await binding.isCurrent())
        }
    }

    @Test func `presentation retirement clears an inspection before its chat registers`() async throws {
        try await self.withHost { host in
            host.registerPresentedChat = false
            let run = OpenClawNativeRunRef(session: host.session(), runID: "run-a")
            let inspection = Task { try await host.router.inspect(run) }
            do {
                let receipt = try await host.waitForReceipt()
                let binding = try #require(host.binding)
                let presentationID = try #require(host.presentationID)
                host.router.unregisterPresentation(presentationID)
                #expect(host.binding == nil)
                #expect(host.receipt == nil)
                host.router.acknowledgeInspection(receipt, presentationID: presentationID)
                #expect(!host.router.isInspectionPresented(receipt))
                await #expect(throws: CancellationError.self) { _ = try await inspection.value }
                #expect(await binding.isCurrent())
            } catch {
                inspection.cancel()
                _ = try? await inspection.value
                throw error
            }
            #expect(host.sent.isEmpty)
        }
    }

    @Test func `stale and duplicate presentation departures cannot retire a successor`() async throws {
        try await self.withHost { host in
            let oldID = try #require(host.presentationID)
            host.router.unregisterPresentation(oldID)
            var successorRetirements = 0
            let currentID = host.router.registerPresentation(onRetire: { successorRetirements += 1 }) { _, _, _ in }
            host.presentationID = currentID
            host.router.unregisterPresentation(oldID)
            host.router.unregisterPresentation(oldID)
            #expect(successorRetirements == 0)
            host.router.unregisterPresentation(currentID)
            #expect(successorRetirements == 1)
            host.router.unregisterPresentation(currentID)
            #expect(successorRetirements == 1)
            #expect(host.sent.isEmpty)
        }
    }

    @Test func `selection departure during inspection history cannot revive its presentation`() async throws {
        try await self.withHost { host in
            _ = try await host.prepare()
            let chat = try #require(host.chat)
            host.beforeInspectionHistory = {
                chat.switchSession(to: "global", agentID: "research")
                chat.switchSession(to: "global", agentID: "main")
            }
            await #expect(throws: CancellationError.self) {
                _ = try await host.router.inspect(.init(session: host.session(), runID: "run-a"))
            }
            #expect(host.receipt == nil)
            #expect(host.sent.isEmpty)
        }
    }

    @Test func `same-run receipts require their own appearance after selection retirement`() async throws {
        try await self.withHost { host in
            _ = try await host.prepare()
            let run = OpenClawNativeRunRef(session: host.session(), runID: "run-a")
            let first = Task { try await host.router.inspect(run) }
            do {
                let oldReceipt = try await host.waitForReceipt()
                let chat = try #require(host.chat)
                chat.switchSession(to: "global", agentID: "research")
                chat.switchSession(to: "global", agentID: "main")
                #expect(host.receipt == nil)
                host.router.acknowledgeInspection(oldReceipt, presentationID: host.presentationID)
                #expect(!host.router.isInspectionPresented(oldReceipt))
                await #expect(throws: CancellationError.self) { _ = try await first.value }
                let second = Task { try await host.router.inspect(run) }
                do {
                    let current = try await host.waitForReceipt()
                    #expect(current.id != oldReceipt.id)
                    host.router.acknowledgeInspection(oldReceipt, presentationID: host.presentationID)
                    #expect(!host.router.isInspectionPresented(current))
                    host.router.acknowledgeInspection(current, presentationID: host.presentationID)
                    #expect(host.router.isInspectionPresented(current))
                    #expect(try await second.value.run == run)
                } catch {
                    second.cancel()
                    _ = try? await second.value
                    throw error
                }
            } catch {
                first.cancel()
                _ = try? await first.value
                throw error
            }
            #expect(host.sent.isEmpty)
        }
    }

    @Test func `proven account refusal releases the chat for an explicitly verified reopen`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let chat = try #require(host.chat)
            let binding = try #require(host.binding)
            chat.input = "preserved idle text"
            host.rejectMethod = "chat.send"
            do {
                _ = try await prepared.submit()
                Issue.record("The Gateway must reject this send before execution")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message == "chat.send: [INVALID_REQUEST] Selected profile changed")
            }
            #expect(host.rejectMethod == nil)
            #expect(host.sent.count == 1)
            #expect(await binding.isCurrent() == false)
            #expect(await binding.gateway.currentRoute() == binding.route)
            #expect(chat.pendingRunCount == 0)
            #expect(chat.messages.isEmpty)
            #expect(chat.input == "preserved idle text")
            #expect(chat.canPreserveIdleTextDraft)
            try host.hideChat()
            host.model.chatPresentation.sync(appModel: host.model)
            #expect(await host.router.open(.session(host.session())) == .opened)
            let fresh = try #require(host.binding)
            #expect(host.chat !== chat)
            #expect(host.chat?.input == "preserved idle text")
            #expect(fresh.profileObservationID != binding.profileObservationID)
            #expect(await fresh.isCurrent())
            #expect(host.sent.count == 1)
            let next = try await host.prepare()
            #expect(try await next.submit().runID == "run-2")
            #expect(host.sent.count == 2)
        }
    }

    @Test func `uncertain retained confirmation never reports a safe resend`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            host.rejectMethod = "chat.send"
            host.rejectionExecution = "may_have_executed"
            do {
                _ = try await prepared.submit()
                Issue.record("Handler entry must preserve delivery uncertainty")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message == "The selected account changed. "
                    + "Delivery is unconfirmed; check the chat before retrying.")
            }
            #expect(host.rejectMethod == nil)
            #expect(host.sent.count == 1)
            do {
                _ = try await prepared.submit()
                Issue.record("A retired confirmation cannot replay or claim non-dispatch")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message ==
                    "Reconnect to the selected account to check this operation. Do not send it again.")
            }
            #expect(host.sent.count == 1)
        }
    }

    @Test func `accepted acknowledgement survives target retirement without a second send`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let chat = try #require(host.chat)
            host.beforeSendReply = {
                chat.switchSession(to: "global", agentID: "research")
                chat.switchSession(to: "global", agentID: "main")
            }
            let run = try await prepared.submit()
            #expect(run.runID == "run-1")
            #expect(run.session == host.session())
            #expect(host.sent.count == 1)
            do {
                _ = try await prepared.submit()
                Issue.record("A retired confirmation cannot claim that the accepted send never happened")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message ==
                    "Reconnect to the selected account to check this operation. Do not send it again.")
            }
            #expect(host.sent.count == 1)
        }
    }

    @Test(arguments: [false, true], ["disconnect", "account refusal"])
    func `retained confirmations preserve no resend after gateway verification fails`(
        uncertain: Bool, retirement: String) async throws
    {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            let binding = try #require(host.binding)
            if uncertain {
                host.rejectMethod = "chat.send"
                host.rejectionExecution = "may_have_executed"
                do {
                    _ = try await prepared.submit()
                    Issue.record("The original send must retain delivery uncertainty")
                } catch let error as OpenClawNativeActionError {
                    #expect(error.message == "The selected account changed. "
                        + "Delivery is unconfirmed; check the chat before retrying.")
                }
            } else {
                #expect(try await prepared.submit() == .init(session: host.session(), runID: "run-1"))
            }
            #expect(host.sent.count == 1)
            if retirement == "disconnect" {
                await host.model.operatorSession.disconnect()
                #expect(await binding.gateway.currentRoute() != binding.route)
            } else {
                host.rejectMethod = "users.self"
                host.rejectionExecution = "not_started"
                #expect(await binding.gateway.currentRoute() == binding.route)
            }
            do {
                _ = try await prepared.submit()
                Issue.record("Failed verification cannot expose a retained receipt or imply safe replay")
            } catch let error as OpenClawNativeActionError {
                #expect(error.message ==
                    "Reconnect to the selected account to check this operation. Do not send it again.")
            }
            #expect(host.rejectMethod == nil)
            #expect(await binding.isCurrent() == false)
            #expect(host.sent.count == 1)
        }
    }

    @Test func `disconnected initial confirmation keeps its admission error without sending`() async throws {
        try await self.withHost { host in
            let prepared = try await host.prepare()
            await host.model.operatorSession.disconnect()
            await #expect(throws: CancellationError.self) { _ = try await prepared.submit() }
            #expect(host.sent.isEmpty)
        }
    }
}
