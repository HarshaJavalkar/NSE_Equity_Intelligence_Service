import { Directive, ElementRef, Renderer2, input, effect } from '@angular/core';

@Directive({
  selector: 'svg[lucideIcon]',
  standalone: true,
})
export class IconDirective {
  readonly lucideIcon = input.required<string>();

  constructor(element: ElementRef<SVGElement>, renderer: Renderer2) {
    effect(() => {
      const iconName = this.lucideIcon();
      if (!/^[a-z0-9-]+$/.test(iconName)) return;

      renderer.setAttribute(element.nativeElement, 'aria-hidden', 'true');
      renderer.setStyle(element.nativeElement, 'display', 'inline-block');
      renderer.setStyle(element.nativeElement, 'flex', '0 0 auto');
      renderer.setStyle(element.nativeElement, 'background-color', 'currentColor');
      renderer.setStyle(
        element.nativeElement,
        'mask',
        `url('/icons/${iconName}.svg') center / contain no-repeat`,
      );
      renderer.setStyle(
        element.nativeElement,
        '-webkit-mask',
        `url('/icons/${iconName}.svg') center / contain no-repeat`,
      );
    });
  }
}
