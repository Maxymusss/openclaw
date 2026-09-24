
platform :ios do
  lane :mv1_replay do
    device = available_simulator_devices.find { |candidate| candidate.fetch("name") == snapshot_devices.first }
    root = File.join(ios_root, "build", "MV1Replay")
    FileUtils.mkdir_p(root)
    1.upto(23) do |iteration|
      output = File.join(root, "iteration-#{iteration}")
      FileUtils.mkdir_p(output)
      selected = iteration <= 20 ? RELEASE_IOS_SCREENSHOT_TESTS.select { |entry| entry.fetch(:test) == "testReleaseAgentScreenshot" } : RELEASE_IOS_SCREENSHOT_TESTS
      attempts = []
      selected.each do |screenshot|
        capture_release_ios_screenshot!(
          project: File.join(ios_root, "OpenClaw.xcodeproj"),
          device: device.fetch("name"), device_udid: device.fetch("udid"),
          screenshot: screenshot,
          output_directory: File.join(ios_root, "fastlane", "screenshots"),
          result_bundle_path: File.join(output, "current.xcresult"),
          result_bundle_archive_directory: output,
          capture_attempts: attempts,
          capture_attempts_path: File.join(output, "capture-attempts.json"),
          derived_data_path: File.join(ios_root, "build", "SnapshotDerivedData"),
          snapshot_cache_directory: File.expand_path("~/Library/Caches/tools.fastlane")
        )
      end
      UI.success("MV1 iteration #{iteration}/23 passed: #{selected.length} captures")
    end
  end
end
