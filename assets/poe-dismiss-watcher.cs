using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

internal static class PoeDismissWatcher
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    private static readonly int[] MouseButtons = { 0x01, 0x02, 0x04, 0x05, 0x06 };

    private static bool AnyMouseButtonDown()
    {
        foreach (int button in MouseButtons)
            if ((GetAsyncKeyState(button) & 0x8000) != 0) return true;
        return false;
    }

    private static bool AnyMouseButtonActivity()
    {
        foreach (int button in MouseButtons)
        {
            // High bit: currently down. Low bit: pressed since the last call.
            if (((ushort)GetAsyncKeyState(button) & 0x8001) != 0) return true;
        }
        return false;
    }

    public static int Main(string[] args)
    {
        ulong rawHandle;
        if (args.Length != 1 || !ulong.TryParse(args[0], NumberStyles.None,
            CultureInfo.InvariantCulture, out rawHandle)) return 2;
        IntPtr window = new IntPtr(unchecked((long)rawHandle));

        while (AnyMouseButtonDown()) Thread.Sleep(15);
        foreach (int button in MouseButtons) GetAsyncKeyState(button);
        while (IsWindow(window))
        {
            if (AnyMouseButtonActivity())
            {
                Point cursor;
                Rect bounds;
                if (GetCursorPos(out cursor) && GetWindowRect(window, out bounds)
                    && (cursor.X < bounds.Left || cursor.X >= bounds.Right
                        || cursor.Y < bounds.Top || cursor.Y >= bounds.Bottom))
                    return 0;
                while (AnyMouseButtonDown()) Thread.Sleep(15);
            }
            Thread.Sleep(15);
        }
        return 2;
    }
}
