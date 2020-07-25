import {Component, HostListener, OnInit} from '@angular/core';
import {WalletService} from "./services/wallet.service";
import {AddressBookService} from "./services/address-book.service";
import {AppSettingsService} from "./services/app-settings.service";
import {WebsocketService} from "./services/websocket.service";
import {PriceService} from "./services/price.service";
import {NotificationService} from "./services/notification.service";
import {WorkPoolService} from "./services/work-pool.service";
import {Router} from "@angular/router";
import {RepresentativeService} from "./services/representative.service";
import {NodeService} from "./services/node.service";
import { LedgerService } from './services';


@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {
  @HostListener('window:resize', ['$event']) onResize (e) {
    this.windowHeight = e.target.innerHeight;
  };
  wallet = this.walletService.wallet;
  node = this.nodeService.node;
  nanoPrice = this.price.price;
  fiatTimeout = 5 * 60 * 1000; // Update fiat prices every 5 minutes
  inactiveSeconds = 0;
  windowHeight = 1000;
  navExpanded = false;
  showSearchBar = false;
  searchData = '';
  isConfigured = this.walletService.isConfigured;

  constructor(
    public walletService: WalletService,
    private addressBook: AddressBookService,
    public settings: AppSettingsService,
    private websocket: WebsocketService,
    private notifications: NotificationService,
    public nodeService: NodeService,
    private representative: RepresentativeService,
    private router: Router,
    private workPool: WorkPoolService,
    private ledger: LedgerService,
    public price: PriceService) { 
      router.events.subscribe(() => { this.navExpanded = false })
    }

  async ngOnInit() {
    this.windowHeight = window.innerHeight;
    this.settings.loadAppSettings();

    // New for v19: Patch saved xrb_ prefixes to nano_
    await this.patchXrbToNanoPrefixData();

    this.addressBook.loadAddressBook();
    this.workPool.loadWorkCache();

    await this.walletService.loadStoredWallet();
    this.websocket.connect();

    this.representative.loadRepresentativeList();

    // If the wallet is locked and there is a pending balance, show a warning to unlock the wallet (if not receive priority is set to manual)
    if (this.wallet.locked && this.walletService.hasPendingTransactions() && this.settings.settings.pendingOption !== 'manual') {
      this.notifications.sendWarning(`New incoming transaction(s) - Unlock the wallet to receive`, { length: 10000, identifier: 'pending-locked' });
    }
    else if (this.walletService.hasPendingTransactions() && this.settings.settings.pendingOption === 'manual') {
      this.notifications.sendWarning(`Incoming transaction(s) found - Set to be received manually`, { length: 10000, identifier: 'pending-locked' });
    }

    // If they are using a Ledger device with a bad browser, warn them
    if (this.walletService.isLedgerWallet() && this.ledger.isBrokenBrowser()) {
      this.notifications.sendLedgerChromeWarning();
    }

    // When the page closes, determine if we should lock the wallet
    window.addEventListener("beforeunload",  (e) => {
      if (this.wallet.locked) return; // Already locked, nothing to worry about
      this.walletService.lockWallet();
    });
    window.addEventListener("unload",  (e) => {
      if (this.wallet.locked) return; // Already locked, nothing to worry about
      this.walletService.lockWallet();
    });

    // Listen for an xrb: protocol link, triggered by the desktop application
    window.addEventListener('protocol-load', (e: CustomEvent) => {
      const protocolText = e.detail;
      const stripped = protocolText.split('').splice(4).join(''); // Remove xrb:
      if (stripped.startsWith('xrb_')) {
        this.router.navigate(['account', stripped]);
      }
      // Soon: Load seed, automatic send page?
    });

    // Check how long the wallet has been inactive, and lock it if it's been too long
    setInterval(() => {
      this.inactiveSeconds += 1;
      if (!this.settings.settings.lockInactivityMinutes) return; // Do not lock on inactivity
      if (this.wallet.locked || !this.wallet.password) return;

      // Determine if we have been inactive for longer than our lock setting
      if (this.inactiveSeconds >= this.settings.settings.lockInactivityMinutes * 60) {
        this.walletService.lockWallet();
        this.notifications.sendSuccess(`Wallet locked after ${this.settings.settings.lockInactivityMinutes} minutes of inactivity`);
      }
    }, 1000);

    try {
      if (!this.settings.settings.serverAPI) return;
      await this.updateFiatPrices();
    } catch (err) {
      this.notifications.sendWarning(`There was an issue retrieving latest Nano price.  Ensure your AdBlocker is disabled on this page then reload to see accurate FIAT values.`, { length: 0, identifier: `price-adblock` });
    }

  }

  /*
    This is important as it looks through saved data using hardcoded xrb_ prefixes
    (Your wallet, address book, rep list, etc) and updates them to nano_ prefix for v19 RPC
   */
  async patchXrbToNanoPrefixData() {
    // If wallet is version 2, data has already been patched.  Otherwise, patch all data
    if (this.settings.settings.walletVersion >= 2) return;

    await this.walletService.patchOldSavedData(); // Change saved xrb_ addresses to nano_
    this.addressBook.patchXrbPrefixData();
    this.representative.patchXrbPrefixData();

    this.settings.setAppSetting('walletVersion', 2); // Update wallet version so we do not patch in the future.
  }

  toggleNav() {
    this.navExpanded = !this.navExpanded
  }

  closeNav() {
    this.navExpanded = false;
  }

  toggleSearch(mobile = false) {
    this.showSearchBar = !this.showSearchBar;
    if (this.showSearchBar) {
      setTimeout(() => document.getElementById(mobile ? 'search-input-mobile' : 'search-input').focus(), 150);
    }
  }

  performSearch() {
    const searchData = this.searchData.trim();
    if (!searchData.length) return;

    if (searchData.startsWith('xrb_') || searchData.startsWith('nano_')) {
      this.router.navigate(['account', searchData]);
    } else if (searchData.length === 64) {
      this.router.navigate(['transaction', searchData]);
    } else {
      this.notifications.sendWarning(`Invalid Nano account or transaction hash!`)
    }
    this.searchData = '';
  }

  updateIdleTime() {
    this.inactiveSeconds = 0; // Action has happened, reset the inactivity timer
  }

  retryConnection() {
    if (!this.settings.settings.serverAPI) {
      this.notifications.sendInfo(`Wallet server settings is set to offline mode. Please change server first!`);
      return;
    }
    this.walletService.reloadBalances(true);
    this.notifications.sendInfo(`Attempting to reconnect to Nano node`);
  }

  async updateFiatPrices() {
    const displayCurrency = this.settings.getAppSetting(`displayCurrency`) || 'USD';
    await this.price.getPrice(displayCurrency);
    this.walletService.reloadFiatBalances();
    setTimeout(() => this.updateFiatPrices(), this.fiatTimeout);
  }
}
