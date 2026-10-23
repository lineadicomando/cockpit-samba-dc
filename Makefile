PKG_NAME := samba-dc
DIST_DIR  := dist
LOCAL_COCKPIT_DIR := $(HOME)/.local/share/cockpit
PROD_COCKPIT_DIR := /usr/share/cockpit
INSTALL_DIR := $(PROD_COCKPIT_DIR)/$(PKG_NAME)
DEB_DIR := build

-include Makefile.local

.PHONY: all clean distclean build watch install uninstall devel-install devel-uninstall check pot po-compile next-version release deb deb-package deb-changelog deb-binary help

all: build

build: ## Build bundle in dist/
	node build.js

watch: ## Watch mode (auto-rebuild)
	node build.js --watch

clean: ## Remove build artifacts
	rm -rf $(DIST_DIR) $(DEB_DIR)

distclean: clean ## Remove build artifacts and node_modules
	rm -rf node_modules

devel-install: build ## Symlink dist/ into local cockpit directory
	mkdir -p $(LOCAL_COCKPIT_DIR)
	ln -sfn $(CURDIR)/$(DIST_DIR) $(LOCAL_COCKPIT_DIR)/$(PKG_NAME)

devel-uninstall: ## Remove local cockpit symlink
	rm -f $(LOCAL_COCKPIT_DIR)/$(PKG_NAME)

install: build ## Copy dist/ into /usr/share/cockpit (system-wide, needs root)
	install -d $(INSTALL_DIR)
	cp -a $(DIST_DIR)/. $(INSTALL_DIR)/

uninstall: ## Remove the system-wide install from /usr/share/cockpit
	rm -rf $(INSTALL_DIR)

check: ## Run unit tests (the page and the core)
	npm test
	cd core && python3 -m unittest discover -s tests

pot: ## Extract translatable strings from src/ → src/locales/en/translation.json + src/locales/it/translation.json (skeleton)
	npm run pot

po-compile: ## Compile po/it.po → src/locales/it/translation.json
	npm run po-compile

next-version: ## Version of the next release, from CHANGELOG.md checked against TODO.md
	node scripts/release.mjs next "$(VERSION)"

release: ## Commit and tag the next release (VERSION=x.y.z only to go higher); nothing is pushed
	node scripts/release.mjs prepare "$(VERSION)"

deb: build ## Build the Debian package into build/ (needs podman or docker)
	$(MAKE) deb-package

deb-package: deb-changelog ## Package the dist/ already built, in a Debian 13 container, and run lintian
	scripts/deb-container.sh

deb-changelog: ## Write debian/changelog for the version being built
	node scripts/debian.mjs changelog > debian/changelog.tmp
	mv debian/changelog.tmp debian/changelog

deb-binary: ## Package the dist/ already built, on Debian (needs debhelper, no Node.js)
	rm -f $(DEB_DIR)/*.deb
	mkdir -p $(DEB_DIR)
	# Rules-Requires-Root: no, which dpkg-buildpackage would pass on itself.
	DEB_RULES_REQUIRES_ROOT=no debian/rules clean
	DEB_RULES_REQUIRES_ROOT=no DEB_OUT=$(CURDIR)/$(DEB_DIR) debian/rules binary

help:
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F ':.*?## ' '{printf "  %-18s %s\n", $$1, $$2}'
