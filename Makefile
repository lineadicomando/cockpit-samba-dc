PKG_NAME := samba-dc
DIST_DIR  := dist
LOCAL_COCKPIT_DIR := $(HOME)/.local/share/cockpit
PROD_COCKPIT_DIR := /usr/share/cockpit
INSTALL_DIR := $(PROD_COCKPIT_DIR)/$(PKG_NAME)

-include Makefile.local

.PHONY: all clean distclean build watch install uninstall devel-install devel-uninstall check pot po-compile release help

all: build

build: ## Build bundle in dist/
	node build.js

watch: ## Watch mode (auto-rebuild)
	node build.js --watch

clean: ## Remove build artifacts
	rm -rf $(DIST_DIR)

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

check: ## Run unit tests
	npm test

pot: ## Extract translatable strings from src/ → src/locales/en/translation.json + src/locales/it/translation.json (skeleton)
	npm run pot

po-compile: ## Compile po/it.po → src/locales/it/translation.json
	npm run po-compile

release: ## Commit and tag a release: make release VERSION=x.y.z (nothing is pushed)
	node scripts/release.mjs prepare "$(VERSION)"

help:
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F ':.*?## ' '{printf "  %-18s %s\n", $$1, $$2}'
