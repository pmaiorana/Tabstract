//
//  DebugFlagsManager.swift
//  Tabstract
//
//  Manages debug flags shared between macOS app and Safari extension via App Groups
//  Using Team ID prefix to avoid Sequoia permission dialog
//

import Foundation

/// Manages debug flags shared between the macOS app and Safari extension
class DebugFlagsManager {

    // MARK: - Constants

    /// App Group identifier with Team ID prefix (required for macOS Sequoia)
    private static let appGroupIdentifier = "84HBFJDM48.group.com.paulmaiorana.Tabstract"

    /// UserDefaults key for debug force not Pro flag
    private static let debugForceNotProKey = "debugForceNotPro"

    // MARK: - Shared Instance

    static let shared = DebugFlagsManager()

    private init() {}

    // MARK: - Shared UserDefaults

    /// Get shared UserDefaults for App Group
    private var sharedDefaults: UserDefaults? {
        return UserDefaults(suiteName: DebugFlagsManager.appGroupIdentifier)
    }

    // MARK: - Public Methods

    /// Check if debug force not Pro flag is set
    func isDebugForceNotPro() -> Bool {
        // First check shared App Group defaults
        if let shared = sharedDefaults {
            return shared.bool(forKey: DebugFlagsManager.debugForceNotProKey)
        }

        // Fallback to standard UserDefaults (for backwards compatibility)
        return UserDefaults.standard.bool(forKey: DebugFlagsManager.debugForceNotProKey)
    }

    /// Set debug force not Pro flag (called by macOS app's 7-tap toggle)
    func setDebugForceNotPro(_ value: Bool) {
        // Write to both shared and standard defaults
        sharedDefaults?.set(value, forKey: DebugFlagsManager.debugForceNotProKey)
        UserDefaults.standard.set(value, forKey: DebugFlagsManager.debugForceNotProKey)

        // Force synchronization
        sharedDefaults?.synchronize()
        UserDefaults.standard.synchronize()

        print("DebugFlagsManager: Set debugForceNotPro to \(value)")
    }
}
