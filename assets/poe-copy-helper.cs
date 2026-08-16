using System;
using System.Threading;
using System.Windows.Forms;

internal static class PoeCopyHelper
{
    [STAThread]
    public static int Main()
    {
        // Alt+D is a manual user action. Wait for Alt to be released, then send
        // exactly one Ctrl+C to whichever application currently owns the focus.
        Thread.Sleep(90);
        SendKeys.SendWait("^c");
        return 0;
    }
}
