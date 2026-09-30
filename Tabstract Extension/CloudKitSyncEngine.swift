//
//  CloudKitSyncEngine.swift
//  Tabstract Extension
//
//  Created by Paul Maiorana
//

import CloudKit
import os.log

struct SyncTimeoutError: Error, LocalizedError {
    var errorDescription: String? { "Operation timed out" }
}

func withThrowingTimeout<T: Sendable>(seconds: Double, operation: @Sendable @escaping () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw SyncTimeoutError()
        }
        let result = try await group.next()!
        group.cancelAll()
        return result
    }
}

@available(macOS 12.0, iOS 16.0, *)
actor CloudKitSyncEngine {

    // MARK: - Constants

    static let containerID = "iCloud.com.paulmaiorana.Tabstract"
    static let zoneName = "TabstractZone"
    #if os(macOS)
    static let appGroupID = "84HBFJDM48.group.com.paulmaiorana.Tabstract"
    #else
    static let appGroupID = "group.com.paulmaiorana.Tabstract"
    #endif
    static let schemaVersion: Int64 = 1
    static let maxRecordsPerBatch = 400
    static let tombstoneTTLDays = 30

    /// Shared formatter — uses fractional seconds to match JS `Date.toISOString()`.
    /// Must only be used from the actor (not `nonisolated` methods).
    private static let iso8601Formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    // MARK: - Properties

    private let container: CKContainer
    private let privateDB: CKDatabase
    private let zoneID: CKRecordZone.ID

    // Account status cache — avoids redundant CloudKit calls within 60s
    private var cachedAccountStatus: [String: Any]?
    private var accountStatusCacheTime: Date?
    private let accountStatusCacheTTL: TimeInterval = 60

    // MARK: - Initialization

    init() {
        self.container = CKContainer(identifier: CloudKitSyncEngine.containerID)
        self.privateDB = container.privateCloudDatabase
        self.zoneID = CKRecordZone.ID(
            zoneName: CloudKitSyncEngine.zoneName,
            ownerName: CKCurrentUserDefaultName
        )
    }

    // MARK: - Sync Directory

    private func syncDirectoryURL() -> URL? {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: CloudKitSyncEngine.appGroupID
        ) else {
            os_log(.error, "CloudKitSyncEngine: Failed to access App Group container")
            return nil
        }
        let syncDir = containerURL.appendingPathComponent("sync", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: syncDir, withIntermediateDirectories: true)
        } catch {
            os_log(.error, "CloudKitSyncEngine: Failed to create sync directory: %@", error.localizedDescription)
            return nil
        }
        return syncDir
    }

    // MARK: - Device ID

    func getOrCreateDeviceID() -> String {
        guard let syncDir = syncDirectoryURL() else { return UUID().uuidString }
        let deviceIDFile = syncDir.appendingPathComponent("deviceID.txt")

        if let existing = try? String(contentsOf: deviceIDFile, encoding: .utf8), !existing.isEmpty {
            return existing.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let newID = UUID().uuidString
        try? newID.write(to: deviceIDFile, atomically: true, encoding: .utf8)
        return newID
    }

    // MARK: - Account Identity

    /// Fetches the current iCloud user record ID and compares it with the stored one.
    /// If the account has changed, clears the change token so the next pull does a full fetch.
    /// Returns true if the account is the same (or first time), false if switched.
    ///
    /// When `forceCheck` is false and a userRecordID is already stored, skips the network
    /// call to `container.userRecordID()` for faster no-op syncs.
    func checkForAccountSwitch(forceCheck: Bool = false) async -> Bool {
        let state = loadSyncState()
        let storedUserID = state["userRecordID"] as? String

        // Fast path: skip network call when we already have a stored ID
        if !forceCheck, storedUserID != nil {
            return true
        }

        do {
            let userRecordID = try await container.userRecordID()
            let currentUserID = userRecordID.recordName

            if let storedUserID = storedUserID, storedUserID != currentUserID {
                // Account switched — clear change token and update stored ID
                os_log(.info, "CloudKitSyncEngine: iCloud account changed, clearing change token")
                saveChangeToken(nil)
                var newState = state
                newState["userRecordID"] = currentUserID
                saveSyncState(newState)
                return false
            } else if storedUserID == nil {
                // First time — store the user ID
                var newState = state
                newState["userRecordID"] = currentUserID
                saveSyncState(newState)
            }
            return true
        } catch {
            os_log(.error, "CloudKitSyncEngine: Failed to fetch user record ID: %@", error.localizedDescription)
            return true // Don't block sync on transient errors
        }
    }

    // MARK: - Change Token

    private func loadChangeToken() -> CKServerChangeToken? {
        guard let syncDir = syncDirectoryURL() else { return nil }
        let tokenFile = syncDir.appendingPathComponent("changeToken.data")
        guard let data = try? Data(contentsOf: tokenFile) else { return nil }

        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: data)
    }

    private func saveChangeToken(_ token: CKServerChangeToken?) {
        guard let syncDir = syncDirectoryURL() else { return }
        let tokenFile = syncDir.appendingPathComponent("changeToken.data")

        guard let token = token else {
            try? FileManager.default.removeItem(at: tokenFile)
            return
        }

        if let data = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true) {
            try? data.write(to: tokenFile, options: .atomic)
        }
    }

    func clearChangeToken() {
        saveChangeToken(nil)
    }

    // MARK: - Sync State

    private func loadSyncState() -> [String: Any] {
        guard let syncDir = syncDirectoryURL() else { return [:] }
        let stateFile = syncDir.appendingPathComponent("syncState.json")
        guard let data = try? Data(contentsOf: stateFile),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return dict
    }

    private func saveSyncState(_ state: [String: Any]) {
        guard let syncDir = syncDirectoryURL() else { return }
        let stateFile = syncDir.appendingPathComponent("syncState.json")
        guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted]) else { return }
        try? data.write(to: stateFile, options: .atomic)
    }

    func getSyncStatus() -> [String: Any] {
        var state = loadSyncState()
        state["deviceID"] = getOrCreateDeviceID()
        return state
    }

    func setEnabled(_ enabled: Bool) {
        var state = loadSyncState()
        state["enabled"] = enabled
        if !enabled {
            state["lastError"] = nil
        }
        saveSyncState(state)
    }

    func updateLastSyncTime() {
        var state = loadSyncState()
        state["lastSyncTime"] = CloudKitSyncEngine.iso8601Formatter.string(from: Date())
        state["lastError"] = nil
        saveSyncState(state)
    }

    func updateLastError(_ error: String) {
        var state = loadSyncState()
        state["lastError"] = error
        saveSyncState(state)
    }

    func clearLastError() {
        var state = loadSyncState()
        state["lastError"] = nil
        saveSyncState(state)
    }

    // MARK: - Account Status

    func checkAccountStatus() async -> [String: Any] {
        // Return cached result if still valid and last check was "available"
        if let cached = cachedAccountStatus,
           let cacheTime = accountStatusCacheTime,
           Date().timeIntervalSince(cacheTime) < accountStatusCacheTTL,
           cached["status"] as? String == "available" {
            return cached
        }

        do {
            let status = try await self.container.accountStatus()
            var result: [String: Any]
            switch status {
            case .available:
                result = ["status": "available"]
            case .noAccount:
                // CKContainer caches accountStatus within the process and the
                // extension handler has no run loop to receive CKAccountChanged.
                // Cross-check with ubiquityIdentityToken which doesn't cache.
                if FileManager.default.ubiquityIdentityToken != nil {
                    os_log(.info, "CloudKitSyncEngine: accountStatus=noAccount but ubiquityIdentityToken present — treating as temporarily unavailable")
                    result = ["status": "temporarilyUnavailable"]
                } else {
                    result = ["status": "noAccount"]
                }
            case .restricted:
                result = ["status": "restricted"]
            case .couldNotDetermine:
                result = ["status": "couldNotDetermine"]
            case .temporarilyUnavailable:
                result = ["status": "temporarilyUnavailable"]
            @unknown default:
                result = ["status": "unknown"]
            }

            // Only cache positive "available" results
            if result["status"] as? String == "available" {
                cachedAccountStatus = result
                accountStatusCacheTime = Date()
            } else {
                cachedAccountStatus = nil
                accountStatusCacheTime = nil
            }

            return result
        } catch {
            cachedAccountStatus = nil
            accountStatusCacheTime = nil
            return ["status": "error", "error": mapCKError(error)]
        }
    }

    // MARK: - Zone Management

    func ensureZoneExists() async throws {
        let zone = CKRecordZone(zoneID: zoneID)
        let operation = CKModifyRecordZonesOperation(recordZonesToSave: [zone])
        operation.qualityOfService = .userInitiated

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            operation.modifyRecordZonesResultBlock = { result in
                switch result {
                case .success:
                    os_log(.info, "CloudKitSyncEngine: Zone created/verified")
                    continuation.resume()
                case .failure(let error):
                    os_log(.error, "CloudKitSyncEngine: Zone creation failed: %@", error.localizedDescription)
                    continuation.resume(throwing: error)
                }
            }
            privateDB.add(operation)
        }
    }

    // MARK: - Push Records

    func pushRecords(records: [[String: Any]]) async -> [String: Any] {
        guard !records.isEmpty else {
            return ["success": true, "pushed": 0]
        }

        let deviceID = getOrCreateDeviceID()
        var totalPushed = 0
        var lastError: String? = nil
        var allFailedRecordNames: [String] = []
        var allConflictRecordNames: [String] = []
        var anyConflicts = false
        var perRecordError: String? = nil

        // Process in batches
        let batches = stride(from: 0, to: records.count, by: CloudKitSyncEngine.maxRecordsPerBatch)
            .map { Array(records[$0..<min($0 + CloudKitSyncEngine.maxRecordsPerBatch, records.count)]) }

        for batch in batches {
            var ckRecords: [CKRecord] = []
            var batchTempURLs: [URL] = []

            for record in batch {
                guard let recordType = record["recordType"] as? String,
                      let recordName = record["recordName"] as? String else {
                    continue
                }

                let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
                let ckRecord = CKRecord(recordType: recordType, recordID: recordID)

                // Write payload to temp file for CKAsset
                if let payload = record["payload"] {
                    if let payloadData = try? JSONSerialization.data(withJSONObject: payload, options: []) {
                        let tempURL = FileManager.default.temporaryDirectory
                            .appendingPathComponent(UUID().uuidString + ".json")
                        do {
                            try payloadData.write(to: tempURL, options: .atomic)
                            ckRecord["payload"] = CKAsset(fileURL: tempURL)
                            batchTempURLs.append(tempURL)
                        } catch {
                            os_log(.error, "CloudKitSyncEngine: Failed to write payload temp file: %@", error.localizedDescription)
                            continue
                        }
                    }
                }

                let modifiedAt = record["modifiedAt"] as? String
                if let modifiedAt = modifiedAt, let date = CloudKitSyncEngine.iso8601Formatter.date(from: modifiedAt) {
                    ckRecord["modifiedAt"] = date as CKRecordValue
                } else {
                    ckRecord["modifiedAt"] = Date() as CKRecordValue
                }

                ckRecord["deviceID"] = deviceID as CKRecordValue
                ckRecord["schemaVersion"] = CloudKitSyncEngine.schemaVersion as CKRecordValue

                let isDeleted = (record["isDeleted"] as? Bool) ?? false
                ckRecord["isDeleted"] = (isDeleted ? 1 : 0) as CKRecordValue

                if isDeleted {
                    ckRecord["deletedAt"] = Date() as CKRecordValue
                }

                ckRecords.append(ckRecord)
            }

            if ckRecords.isEmpty { continue }

            let result = await pushBatch(ckRecords)
            if let error = result["error"] as? String {
                lastError = error
            }
            totalPushed += result["pushed"] as? Int ?? 0
            if let failed = result["failedRecordNames"] as? [String] {
                allFailedRecordNames.append(contentsOf: failed)
            }
            if perRecordError == nil, let failureError = result["failureError"] as? String {
                perRecordError = failureError
            }
            if let conflicts = result["conflictRecordNames"] as? [String] {
                allConflictRecordNames.append(contentsOf: conflicts)
            }
            if result["hasConflicts"] as? Bool == true {
                anyConflicts = true
            }

            // Clean up temp files after batch completes (success or failure)
            for url in batchTempURLs {
                try? FileManager.default.removeItem(at: url)
            }
        }

        // Clean up old tombstones (at most once per 24 hours)
        await purgeStaleTombstonesIfNeeded()

        var response: [String: Any] = ["success": lastError == nil, "pushed": totalPushed]
        if let error = lastError {
            response["error"] = error
        }
        if !allFailedRecordNames.isEmpty {
            response["failedRecordNames"] = allFailedRecordNames
        }
        if !allConflictRecordNames.isEmpty {
            response["conflictRecordNames"] = allConflictRecordNames
        }
        response["hasConflicts"] = anyConflicts
        if let failureError = perRecordError {
            response["failureError"] = failureError
        }
        // Only stamp "last synced" when something actually reached the server.
        // A batch or per-record failure (e.g. offline) is recorded as the last error
        // so the UI stops reporting a sync that never happened.
        if totalPushed > 0 {
            updateLastSyncTime()
        }
        if let failureError = lastError ?? perRecordError {
            updateLastError(failureError)
        }
        return response
    }

    // Thread-safe collector for per-record push outcomes
    private final class PushCollector: @unchecked Sendable {
        private let lock = NSLock()
        private var _conflictRecordNames: [String] = []
        private var _failedRecordNames: [String] = []
        private var _firstFailureError: String? = nil

        func addFailure(_ name: String, isConflict: Bool, errorCode: String? = nil) {
            lock.lock()
            defer { lock.unlock() }
            if isConflict {
                _conflictRecordNames.append(name)
            } else {
                _failedRecordNames.append(name)
                if _firstFailureError == nil { _firstFailureError = errorCode }
            }
        }

        // Mapped code of the first non-conflict per-record failure (e.g. networkUnavailable)
        var firstFailureError: String? {
            lock.lock()
            defer { lock.unlock() }
            return _firstFailureError
        }

        var conflictRecordNames: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _conflictRecordNames
        }

        var failedRecordNames: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _failedRecordNames
        }

        var allFailedNames: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _conflictRecordNames + _failedRecordNames
        }

        var hasConflicts: Bool {
            lock.lock()
            defer { lock.unlock() }
            return !_conflictRecordNames.isEmpty
        }
    }

    private func pushBatch(_ records: [CKRecord]) async -> [String: Any] {
        let operation = CKModifyRecordsOperation(recordsToSave: records)
        operation.savePolicy = .allKeys
        operation.isAtomic = false
        operation.qualityOfService = .userInitiated

        let collector = PushCollector()

        return await withCheckedContinuation { continuation in
            operation.perRecordSaveBlock = { recordID, result in
                switch result {
                case .success:
                    break
                case .failure(let error):
                    let isConflict: Bool
                    if let ckError = error as? CKError, ckError.code == .serverRecordChanged {
                        isConflict = true
                        os_log(.info, "CloudKitSyncEngine: Server conflict for %@", recordID.recordName)
                    } else {
                        isConflict = false
                        os_log(.error, "CloudKitSyncEngine: Per-record error for %@: %@", recordID.recordName, error.localizedDescription)
                    }
                    collector.addFailure(recordID.recordName, isConflict: isConflict,
                                         errorCode: isConflict ? nil : self.mapCKError(error))
                }
            }

            operation.modifyRecordsResultBlock = { result in
                var response: [String: Any]
                switch result {
                case .success:
                    let allFailed = collector.allFailedNames
                    response = [
                        "pushed": records.count - allFailed.count,
                        "failedRecordNames": collector.failedRecordNames,
                        "conflictRecordNames": collector.conflictRecordNames,
                        "hasConflicts": collector.hasConflicts
                    ]
                    if let failureError = collector.firstFailureError {
                        response["failureError"] = failureError
                    }
                case .failure(let error):
                    response = [
                        "pushed": 0,
                        "error": self.mapCKError(error)
                    ]
                    os_log(.error, "CloudKitSyncEngine: Push batch failed: %@", error.localizedDescription)
                }
                continuation.resume(returning: response)
            }

            privateDB.add(operation)
        }
    }

    // MARK: - Pull Changes

    // Collector class to hold mutable state across @Sendable CKOperation callbacks
    // Thread-safe: record callbacks may fire on different threads
    private final class PullCollector: @unchecked Sendable {
        private let lock = NSLock()
        private var _changedRecords: [[String: Any]] = []
        private var _deletedRecordIDs: [[String: Any]] = []
        var newToken: CKServerChangeToken?  // zone-level callbacks are serialized per-zone
        var errorStr: String?
        var tokenExpired = false

        func addChanged(_ record: [String: Any]) {
            lock.lock()
            defer { lock.unlock() }
            _changedRecords.append(record)
        }

        func addDeleted(_ record: [String: Any]) {
            lock.lock()
            defer { lock.unlock() }
            _deletedRecordIDs.append(record)
        }

        var changedRecords: [[String: Any]] {
            lock.lock()
            defer { lock.unlock() }
            return _changedRecords
        }

        var deletedRecordIDs: [[String: Any]] {
            lock.lock()
            defer { lock.unlock() }
            return _deletedRecordIDs
        }
    }

    func pullChanges() async -> [String: Any] {
        let changeToken = loadChangeToken()

        let config = CKFetchRecordZoneChangesOperation.ZoneConfiguration()
        config.previousServerChangeToken = changeToken

        let operation = CKFetchRecordZoneChangesOperation(
            recordZoneIDs: [zoneID],
            configurationsByRecordZoneID: [zoneID: config]
        )
        operation.qualityOfService = .userInitiated

        let collector = PullCollector()
        collector.newToken = changeToken

        let result = await Self.executePullOperation(operation, collector: collector, db: privateDB)

        // Handle token updates on actor context
        if collector.tokenExpired {
            saveChangeToken(nil)
        } else if let token = collector.newToken, collector.errorStr == nil {
            saveChangeToken(token)
        }

        return result
    }

    private nonisolated static func executePullOperation(
        _ operation: CKFetchRecordZoneChangesOperation,
        collector: PullCollector,
        db: CKDatabase
    ) async -> [String: Any] {
        await withCheckedContinuation { (continuation: CheckedContinuation<[String: Any], Never>) in
            operation.recordWasChangedBlock = { recordID, recordResult in
                switch recordResult {
                case .success(let record):
                    var entry: [String: Any] = [
                        "recordType": record.recordType,
                        "recordName": recordID.recordName
                    ]

                    if let asset = record["payload"] as? CKAsset,
                       let fileURL = asset.fileURL,
                       let data = try? Data(contentsOf: fileURL),
                       let payload = try? JSONSerialization.jsonObject(with: data) {
                        entry["payload"] = payload
                    }

                    if let modifiedAt = record["modifiedAt"] as? Date {
                        let formatter = ISO8601DateFormatter()
                        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                        entry["modifiedAt"] = formatter.string(from: modifiedAt)
                    }

                    if let isDeleted = record["isDeleted"] as? Int64 {
                        entry["isDeleted"] = isDeleted == 1
                    }

                    if let deviceID = record["deviceID"] as? String {
                        entry["deviceID"] = deviceID
                    }

                    if let schemaVersion = record["schemaVersion"] as? Int64 {
                        entry["schemaVersion"] = schemaVersion
                    }

                    collector.addChanged(entry)

                case .failure(let error):
                    os_log(.error, "CloudKitSyncEngine: Record fetch error for %@: %@", recordID.recordName, error.localizedDescription)
                }
            }

            operation.recordWithIDWasDeletedBlock = { recordID, recordType in
                collector.addDeleted([
                    "recordName": recordID.recordName,
                    "recordType": recordType
                ])
            }

            operation.recordZoneChangeTokensUpdatedBlock = { _, token, _ in
                if let token = token {
                    collector.newToken = token
                }
            }

            operation.recordZoneFetchResultBlock = { _, zoneResult in
                switch zoneResult {
                case .success(let tuple):
                    collector.newToken = tuple.0
                case .failure(let error):
                    let ckError = error as? CKError
                    if ckError?.code == .changeTokenExpired {
                        collector.errorStr = "tokenExpired"
                        collector.tokenExpired = true
                    } else {
                        collector.errorStr = CloudKitSyncEngine.mapCKErrorStatic(error)
                    }
                    os_log(.error, "CloudKitSyncEngine: Zone fetch failed: %@", error.localizedDescription)
                }
            }

            operation.fetchRecordZoneChangesResultBlock = { overallResult in
                switch overallResult {
                case .success:
                    break
                case .failure(let error):
                    if collector.errorStr == nil {
                        collector.errorStr = CloudKitSyncEngine.mapCKErrorStatic(error)
                    }
                    os_log(.error, "CloudKitSyncEngine: Pull changes failed: %@", error.localizedDescription)
                }

                var response: [String: Any] = [
                    "success": collector.errorStr == nil,
                    "changes": collector.changedRecords,
                    "deletions": collector.deletedRecordIDs
                ]
                if let err = collector.errorStr {
                    response["error"] = err
                }
                continuation.resume(returning: response)
            }

            db.add(operation)
        }
    }

    // MARK: - Tombstone Cleanup

    private func purgeStaleTombstonesIfNeeded() async {
        let state = loadSyncState()
        if let lastPurge = state["lastTombstonePurge"] as? String,
           let lastDate = CloudKitSyncEngine.iso8601Formatter.date(from: lastPurge),
           Date().timeIntervalSince(lastDate) < 604800 {
            return // Less than 7 days since last purge
        }
        await purgeStaleTombstones()
        var newState = loadSyncState()
        newState["lastTombstonePurge"] = CloudKitSyncEngine.iso8601Formatter.string(from: Date())
        saveSyncState(newState)
    }

    private func purgeStaleTombstones() async {
        let predicate = NSPredicate(format: "isDeleted == 1 AND deletedAt < %@",
                                    Calendar.current.date(byAdding: .day,
                                                         value: -CloudKitSyncEngine.tombstoneTTLDays,
                                                         to: Date())! as NSDate)

        // Purge tombstones for all record types
        let recordTypes = ["Session", "Template", "SmartGroup", "TrashedLink"]

        for recordType in recordTypes {
            let typeQuery = CKQuery(recordType: recordType, predicate: predicate)
            do {
                let (results, _) = try await privateDB.records(matching: typeQuery, inZoneWith: zoneID)
                let idsToDelete = results.compactMap { result -> CKRecord.ID? in
                    switch result.1 {
                    case .success(let record): return record.recordID
                    case .failure: return nil
                    }
                }

                if !idsToDelete.isEmpty {
                    let deleteOp = CKModifyRecordsOperation(recordIDsToDelete: idsToDelete)
                    deleteOp.qualityOfService = .utility

                    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                        deleteOp.modifyRecordsResultBlock = { _ in
                            continuation.resume()
                        }
                        self.privateDB.add(deleteOp)
                    }

                    os_log(.info, "CloudKitSyncEngine: Purged %d stale tombstones for %@", idsToDelete.count, recordType)
                }
            } catch {
                os_log(.error, "CloudKitSyncEngine: Tombstone query failed for %@: %@", recordType, error.localizedDescription)
            }
        }
    }

    // MARK: - Error Mapping

    nonisolated func mapCKError(_ error: Error) -> String {
        Self.mapCKErrorStatic(error)
    }

    nonisolated static func mapCKErrorStatic(_ error: Error) -> String {
        guard let ckError = error as? CKError else {
            let ns = error as NSError
            return "unknown:\(ns.domain):\(ns.code)"
        }

        switch ckError.code {
        case .notAuthenticated:
            return "notAuthenticated"
        case .networkUnavailable, .networkFailure:
            return "networkUnavailable"
        case .requestRateLimited:
            return "rateLimited"
        case .quotaExceeded:
            return "quotaExceeded"
        case .changeTokenExpired:
            return "tokenExpired"
        case .serverRecordChanged:
            return "conflict"
        case .zoneBusy:
            return "zoneBusy"
        case .zoneNotFound, .userDeletedZone:
            return "zoneNotFound"
        case .partialFailure:
            // Zone-level failures (e.g. the zone was deleted) arrive wrapped in a
            // partialFailure; report the first underlying error instead of "unknown".
            if let inner = ckError.partialErrorsByItemID?.values.first {
                return mapCKErrorStatic(inner)
            }
            return "unknown:partialFailure"
        case .incompatibleVersion:
            return "incompatibleVersion"
        case .badContainer:
            return "badContainer"
        case .serviceUnavailable:
            return "serviceUnavailable"
        case .managedAccountRestricted:
            return "managedAccountRestricted"
        default:
            // Keep the raw CKError code so Copy Diagnostics can name it
            return "unknown:\(ckError.code.rawValue)"
        }
    }
}
