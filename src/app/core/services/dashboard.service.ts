import { AppSettingsService } from './app-settings.service';
import {effect, inject, Injectable, Signal, signal} from '@angular/core';
import { Router } from '@angular/router';
import { NgGridStackWidget } from 'gridstack/dist/angular';
import isEqual from 'lodash-es/isEqual';
import cloneDeep from 'lodash-es/cloneDeep';
import { UUID } from '../utils/uuid.util';
import {BehaviorSubject, delayWhen, Observable, retryWhen, sampleTime, tap, throwError, timeout, timer} from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';

/*
Kip-Commander integration
 */

import { SignalkRequestsService } from './signalk-requests.service';
import {DataService, IPathUpdate} from './data.service';


import {forEach} from "lodash-es";


interface DashboardInfo {
  id: string
  name?: string;
  icon?: string;
}

/*****************/

export interface Dashboard {
  id: string
  name?: string;
  icon?: string;
  configuration?: NgGridStackWidget[] | [];
}

export interface widgetOperation {
  id: string;
  operation: 'delete' | 'duplicate';
}

@Injectable({
  providedIn: 'root'
})
export class DashboardService {
  private _settings = inject(AppSettingsService);
  private _router = inject(Router);
  public dashboards = signal<Dashboard[]>([], {equal: isEqual});
  public readonly activeDashboard = signal<number>(0);
  private _widgetAction = new BehaviorSubject<widgetOperation>(null);
  public widgetAction$ = this._widgetAction.asObservable();
  private _isDashboardStatic = new BehaviorSubject<boolean>(true);
  public isDashboardStatic$ = this._isDashboardStatic.asObservable();
  public readonly isDashboardStatic = toSignal(this.isDashboardStatic$);
  public readonly blankDashboard: Dashboard[] = [ {id: null, name: 'Dashboard 1', icon: 'dashboard-dashboard', configuration: [
    {
      "w": 12,
      "h": 12,
      "id": "d1d58e6f-f8b4-4a72-9597-7f92aa6776fc",
      "selector": "widget-tutorial",
      "input": {
        "widgetProperties": {
          "type": "widget-tutorial",
          "uuid": "d1d58e6f-f8b4-4a72-9597-7f92aa6776fc"
        }
      },
      "x": 0,
      "y": 0
    }
  ]} ];

  /*
  Kip-Commander
   */

  private readonly _data = inject(DataService);

  /** Base Signal K path **/
  private basePath: string;

  private readonly _signalk = inject(SignalkRequestsService);

  /**************************************/

  constructor() {
    const dashboards = this._settings.getDashboardConfig();

    if (!dashboards || dashboards.length === 0) {
      console.warn('[Dashboard Service] No dashboards found in settings, creating blank dashboard');
      const newBlankDashboard = this.blankDashboard.map(dashboard => ({
        ...dashboard,
        id: UUID.create()
      }));
      this.dashboards.set([...newBlankDashboard]);
    } else {
      this.dashboards.set(this._settings.getDashboardConfig());
    }

    effect(() => {
      this._settings.saveDashboards(this.dashboards());
    });

    /*
    Kip-Commander
     */

    // Create the user dependant active dashboard path
    this.basePath = "plugins.kip." + this._settings.getConnectionConfig().loginName

    // Update the number of available dashboards on Signal K server
    this.skUpdateMaxDashboard()

    // Update dashboard metadata on Signal K server
    this.skUpdateDashboards();

    // Register the "self.kip.${user}.activeDashboard" for remote dashboard selection
    this._data.subscribePath("self." + this.basePath + ".activeDashboard", 'default').subscribe(
        (newValue: IPathUpdate) => {

          console.log("[Dashboard Service] data: ", newValue)

          // Check if the value is valid
          if (newValue.data.value === null) return;

          // Get the selected dashboard
          const itemIndex = Number(newValue.data.value);

          // Check if the selected dashboard is the current one
          if (itemIndex == this.activeDashboard()) return;

          // Check if the index is in the range
          if (itemIndex < 0 || itemIndex > this.dashboards().length-1) return;

          // Show the page number on the console
          console.log("[Dashboard Service] itemIndex: ", itemIndex, this.activeDashboard())

          // Set the active dashboard
          this.activeDashboard.set(itemIndex);

          // Navigate to the dashboard
          this.navigateToActive()
        })

  }
  /* Kip-Commander */

  protected skUpdateActiveDashboard() {
    this._signalk.putRequest(this.basePath + ".activeDashboard", this.activeDashboard(), this._settings.KipUUID);
  }

  protected skUpdateMaxDashboard() {
    this._signalk.putRequest(this.basePath+".maxDashboard", this.dashboards().length-1,this._settings.KipUUID);
  }

  protected skUpdateDashboards() {
    const dashboardNames: DashboardInfo[] = []

    forEach(this.dashboards(), (dashboard: Dashboard) => {
      dashboardNames.push({ id: dashboard.id, name: dashboard.name, icon: dashboard.icon});
    })

    this._signalk.putRequest(this.basePath+".dashboards", dashboardNames,this._settings.KipUUID);

  }
  /********************/
  /**
   * Toggles the static/fixed state of the dashboard layout.
   */
  public toggleStaticDashboard(): void {
    this._isDashboardStatic.next(!this._isDashboardStatic.value);
  }

  /**
   * Adds a new dashboard with the given name, widget configuration, and optional icon.
   * @param name The name of the new dashboard.
   * @param configuration The widget configuration array.
   * @param icon The optional icon for the dashboard.
   */
  public add(name: string, configuration: NgGridStackWidget[], icon?: string): void {
    this.dashboards.update(dashboards =>
      [ ...dashboards, {id: UUID.create(), name: name, icon: icon, configuration: configuration} ]
    );

    // Update the number of available dashboards on Signal K server
    this.skUpdateMaxDashboard()

    // Update dashboard metadata on Signal K server
    this.skUpdateDashboards();
  }

  /**
   * Updates the name and icon of a dashboard at the specified index.
   * @param itemIndex The index of the dashboard to update.
   * @param name The new name for the dashboard.
   * @param icon The new icon for the dashboard (defaults to "dashboard").
   */
  public update(itemIndex: number, name: string, icon: string): void {
    this.dashboards.update(dashboards => dashboards.map((dashboard, i) =>
      i === itemIndex ? { ...dashboard, name: name, icon: icon } : dashboard));

    // Update dashboard metadata on Signal K server
    this.skUpdateDashboards();
  }

  /**
   * Deletes the dashboard at the specified index.
   * If no dashboards remain, creates a new blank dashboard.
   * @param itemIndex The index of the dashboard to delete.
   */
  public delete(itemIndex: number): void {
    this.dashboards.update(dashboards => dashboards.filter((_, i) => i !== itemIndex));

    if (this.dashboards().length === 0) {
      this.add( 'Dashboard ' + (this.dashboards().length + 1), []);
      this.activeDashboard.set(0);
    } else if (this.activeDashboard() > this.dashboards().length - 1) {
      this.activeDashboard.set(this.dashboards().length - 1);
    }

    // Update the number of available dashboards on Signal K server
    this.skUpdateMaxDashboard()

    // Update the active dashboard on Signal K server
    this.skUpdateActiveDashboard();

    // Update dashboard metadata on Signal K server
    this.skUpdateDashboards();
  }

  /**
   * Duplicates the dashboard at the specified index with a new name and optional icon.
   * All widget and dashboard IDs are regenerated.
   * @param itemIndex The index of the dashboard to duplicate.
   * @param newName The name for the duplicated dashboard.
   * @param newIcon The optional icon for the duplicated dashboard.
   */
  public duplicate(itemIndex: number, newName: string, newIcon?: string): void {
    if (itemIndex < 0 || itemIndex >= this.dashboards().length) {
        console.error(`[Dashboard Service] Invalid itemIndex: ${itemIndex}`);
        return;
    }

    const originalDashboard = this.dashboards()[itemIndex];
    const newDashboard = cloneDeep(originalDashboard);

    newDashboard.id = UUID.create();
    newDashboard.name = newName;
    newDashboard.icon = newIcon || 'dashboard-dashboard';

    if (Array.isArray(newDashboard.configuration)) {
        newDashboard.configuration.forEach((widget: NgGridStackWidget) => {
            if (widget && widget.input?.widgetProperties) {
                widget.id = UUID.create();
                widget.input.widgetProperties.uuid = widget.id;
            } else {
                console.error("Dashboard Service] Widget configuration is missing required properties:", widget);
            }
        });
    } else {
        console.error("Dashboard Service] Dashboard configuration is not an array:", newDashboard.configuration);
        newDashboard.configuration = [];
    }

    this.dashboards.update(dashboards => [
        ...dashboards,
        newDashboard
    ]);

    // Update the number of available dashboards on Signal K server
    this.skUpdateMaxDashboard()

    // Update the active dashboard on Signal K server
    this.skUpdateActiveDashboard();

    // Update dashboard metadata on Signal K server
    this.skUpdateDashboards();
  }

  /**
   * Updates the widget configuration for the dashboard at the specified index.
   * Only updates if the configuration has changed.
   * @param itemIndex The index of the dashboard to update.
   * @param configuration The new widget configuration array.
   */
  public updateConfiguration(itemIndex: number, configuration: NgGridStackWidget[]): void {
    this.dashboards.update(dashboards => dashboards.map((dashboard, i) => {
      if (i === itemIndex) {
        // Only update if the configuration has changed
        if (isEqual(dashboard.configuration, configuration)) {
          return dashboard; // No changes, return the same reference
        }
        return { ...dashboard, configuration: configuration }; // Update with new configuration
      }
      return dashboard; // No changes for other dashboards
    }));
  }

  /**
   * Switches to the previous dashboard in the list.
   * Wraps to the last dashboard if at the beginning.
   * This only updates the internal state and does NOT trigger navigation or URL changes.
   */
  public previousDashboard(): void {
    if ((this.activeDashboard() + 1) > (this.dashboards().length) - 1) {
      this.activeDashboard.set(0);
    } else {
      this.activeDashboard.set(this.activeDashboard() + 1);
    }

    // Update the number of available dashboards on Signal K server
    this.skUpdateMaxDashboard()

    // Update the active dashboard on Signal K server
    this.skUpdateActiveDashboard();
  }

  /**
   * Switches to the next dashboard in the list.
   * Wraps to the first dashboard if at the end.
   * This only updates the internal state and does NOT trigger navigation or URL changes.
   */
  public nextDashboard(): void {
    if ((this.activeDashboard() - 1) < 0) {
      this.activeDashboard.set(this.dashboards().length - 1);
    } else {
      this.activeDashboard.set(this.activeDashboard() - 1);
    }

    // Update the number of available dashboards on Signal K server
    this.skUpdateMaxDashboard()

    // Update the active dashboard on Signal K server
    this.skUpdateActiveDashboard();
  }

  /**
   * Sets the active dashboard index in the service.
   * This only updates the internal state and does NOT trigger navigation or URL changes.
   * @param itemIndex The index of the dashboard to activate.
   */
  public setActiveDashboard(itemIndex: number): void {
    if (itemIndex >= 0 && itemIndex < this.dashboards().length) {
      this.activeDashboard.set(itemIndex);

      // Update the active dashboard on Signal K server
      this.skUpdateActiveDashboard();
    } else {
      console.error(`[Dashboard Service] Invalid dashboard ID: ${itemIndex}`);
    }
  }

  /**
   * Navigates the router to the currently active dashboard.
   * This updates the browser URL and triggers Angular routing.
   */
  public navigateToActive(): void {
    this._router.navigate(['/dashboard', this.activeDashboard()]);
  }

  /**
   * Navigates the router to the dashboard at the specified index.
   * This updates the browser URL and triggers Angular routing.
   * @param itemIndex The index of the dashboard to navigate to.
   */
  public navigateTo(itemIndex: number): void {
    if (itemIndex >= 0 && itemIndex < this.dashboards().length) {
      this._router.navigate(['/dashboard', itemIndex]);

    } else {
      console.error(`[Dashboard Service] Invalid dashboard ID: ${itemIndex}`);
    }

  }

  /**
   * Navigates to the next dashboard in the list.
   * If the current dashboard is the first one, wraps around to the last dashboard.
   * This updates the browser URL and triggers Angular routing.
   */
  public navigateToNextDashboard(): void {
    let nextDashboard: number = null;
    if ((this.activeDashboard() - 1) < 0) {
      nextDashboard = this.dashboards().length - 1;
    } else {
      nextDashboard = this.activeDashboard() - 1;
    }
    this._router.navigate(['/dashboard', nextDashboard]);

  }

  /**
   * Navigates to the previous dashboard in the list.
   * If the current dashboard is the last one, wraps around to the first dashboard.
   * This updates the browser URL and triggers Angular routing.
   */
  public navigateToPreviousDashboard(): void {
    let nextDashboard: number = null;
    if ((this.activeDashboard() + 1) >= this.dashboards().length) {
      nextDashboard = 0;
    } else {
      nextDashboard = this.activeDashboard() + 1;
    }
    this._router.navigate(['/dashboard', nextDashboard]);

  }

  /**
   * Emits a widget delete operation for the widget with the given ID.
   * @param id The widget ID to delete.
   */
  public deleteWidget(id: string): void {
    this._widgetAction.next({id: id, operation: 'delete'});
  }

  /**
   * Emits a widget duplicate operation for the widget with the given ID.
   * @param id The widget ID to duplicate.
   */
  public duplicateWidget(id: string): void {
    this._widgetAction.next({id: id, operation: 'duplicate'});
  }

  /**
   * Sets the static/fixed state of the dashboard layout.
   * @param isStatic Whether the dashboard should be static.
   */
  public setStaticDashboard(isStatic: boolean): void {
    this._isDashboardStatic.next(isStatic);
  }
}
