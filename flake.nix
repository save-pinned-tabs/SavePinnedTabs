{
  description = "Save Pinned Tabs development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              chromium
              firefox-devedition
              geckodriver
              nodejs_22
            ];

            CHROMIUM_BINARY = "${pkgs.chromium}/bin/chromium";
            FIREFOX_BINARY = "${pkgs.firefox-devedition}/bin/firefox-devedition";
          };
        });
    };
}
