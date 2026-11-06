import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';
import { routes } from './app.routes';
import { FindRootVersionComponent } from './find-root-version/find-root-version.component';

describe('AppComponent (shell)', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('should create the shell', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render dependency tree, find-root-version, and builder navigation links in order', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.app-nav')).toBeTruthy();
    expect(el.textContent).not.toContain('Timeline');
    expect(el.textContent).toContain('Dependency Tree');
    expect(el.textContent).toContain('Tree Builder');
    expect(el.textContent).toContain('Find Root Version');
    expect(Array.from(el.querySelectorAll<HTMLAnchorElement>('.app-nav__links a'))
      .map((link) => [link.textContent?.trim(), link.getAttribute('href')])).toEqual([
        ['Dependency Tree', '/tree'],
        ['Find Root Version', '/find-root-version'],
        ['Tree Builder', '/builder'],
      ]);
    expect(routes.find(route => route.path === 'find-root-version')?.component)
      .toBe(FindRootVersionComponent);
  });

  it('should redirect the home route to the dependency tree', () => {
    expect(routes.find((route) => route.path === ''))
      .toEqual({ path: '', redirectTo: 'tree', pathMatch: 'full' });
  });

  it('should render the theme toggle button', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.theme-toggle')).toBeTruthy();
  });

  it('should toggle theme between dark and light', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const component = fixture.componentInstance;
    const initialTheme = component.theme();
    component.toggleTheme();
    expect(component.theme()).not.toBe(initialTheme);
    component.toggleTheme();
    expect(component.theme()).toBe(initialTheme);
  });
});
