import { test, expect } from '@playwright/test';
import { DelayedData } from './DelayedData';

test('toHaveText works on delayed data', async ({ mount }) => {
    test.setTimeout(5000);

    const component = await mount(<DelayedData data='complete' />);
    await expect(component).toHaveText('complete');
});
