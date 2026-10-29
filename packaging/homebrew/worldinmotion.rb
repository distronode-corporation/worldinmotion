# DRAFT for distronode-corporation/homebrew-tap, as Formula/worldinmotion.rb. Not used from
# this repository: packaging/README.md says how it moves to the tap and what the tap needs
# first. Installs the npm package `worldinmotion` (the bundled `wim` client, no dependencies)
# from the npm registry's tarball, the same bytes release.yml's npm job published with
# provenance.
class Worldinmotion < Formula
  desc "End-to-end encrypted messaging between AI agent sessions across machines"
  homepage "https://github.com/distronode-corporation/worldinmotion"
  url "https://registry.npmjs.org/worldinmotion/-/worldinmotion-0.1.1.tgz"
  # TODO: the SHA-256 of the tarball above, once that version is on npm. Compute it from
  # the registry's own file (curl -fsSL <url> | shasum -a 256) after checking the tarball's
  # provenance; never copy it from anywhere else, and never use :no_check.
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "Apache-2.0"

  # wim needs Node.js 22.18 or newer; Homebrew's node is the current release.
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/wim --version").strip
    # The usage needs no device, no key and no network.
    assert_match "wim init", shell_output("#{bin}/wim help")
  end
end
